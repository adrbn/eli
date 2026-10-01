"""Local speech synthesis, either Piper neural voices (downloaded on demand) or macOS `say` voices.

The text can mark English: "j'adore [en]Two People[/en]". Piper then says those words with espeak's English
phonemes, in the same voice (otherwise it would read them the French way). Each synthesis returns (wav, phonemes):
the phonemes and their durations let the face shape the lips; `say` gives none (None).
"""
from __future__ import annotations

import io
import logging
import re
import subprocess
import tempfile
import threading
import urllib.request
import wave
from pathlib import Path
from typing import Callable

import piper_text

try:
    from piper import SynthesisConfig
except ImportError:  # without Piper: only `say` voices
    SynthesisConfig = None

log = logging.getLogger("eli.voice")
CAT = 1.3  # cat voice: synthesized that much slower, then played that much faster → same pace, higher voice

HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
# id → (language, label, Piper model, speaker). Picked by ear among Piper's voices. English ones: only voices whose
# MODEL_CARD dataset is public domain or CC0 (lessac and alan are left out: research-only / all rights reserved).
PIPER = {
    "siwis": ("fr", "Siwis · femme, claire", "fr/fr_FR/siwis/medium/fr_FR-siwis-medium", None),
    "jessica": ("fr", "Jessica · femme, posée", "fr/fr_FR/upmc/medium/fr_FR-upmc-medium", 0),
    "pierre": ("fr", "Pierre · homme, posé", "fr/fr_FR/upmc/medium/fr_FR-upmc-medium", 1),
    "tom": ("fr", "Tom · homme, jeune", "fr/fr_FR/tom/medium/fr_FR-tom-medium", None),
    "gilles": ("fr", "Gilles · homme, grave", "fr/fr_FR/gilles/low/fr_FR-gilles-low", None),
    "kristin": ("en", "Kristin · woman, US", "en/en_US/kristin/medium/en_US-kristin-medium", None),
    "cori": ("en", "Cori · woman, UK", "en/en_GB/cori/medium/en_GB-cori-medium", None),
    "norman": ("en", "Norman · man, US", "en/en_US/norman/medium/en_US-norman-medium", None),
    "john": ("en", "John · man, US", "en/en_US/john/medium/en_US-john-medium", None),
    "joe": ("en", "Joe · man, US", "en/en_US/joe/medium/en_US-joe-medium", None),
}
DEFAULT = {"fr": "siwis", "en": "kristin"}
SAY_FALLBACK = {"fr": "Thomas", "en": "Samantha"}


class PiperTTS:
    def __init__(self, model: Path, speaker: int | None = None, name: str = ""):
        from piper import PiperVoice  # imported here: without Piper, `say` takes over

        try:  # alignments (each phoneme's duration) need the onnx package
            self.voice = PiperVoice.load(str(model), include_alignments=True)
        except Exception as exc:
            log.warning("no phoneme alignments (%s): the mouth will follow the sound only", exc)
            self.voice = PiperVoice.load(str(model))
        self.config = SynthesisConfig(speaker_id=speaker)
        self.lock = threading.Lock()
        self.name = name or f"piper · {model.stem}"

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, list | None] | None:
        """(wav, [[phoneme, duration in ms], …]) or None if nothing is pronounceable ("…")."""
        text = piper_text.to_piper(text)
        rate, pcm, phonemes = round(self.voice.config.sample_rate * (CAT if cat else 1)), [], []
        config = SynthesisConfig(speaker_id=self.config.speaker_id, length_scale=CAT) if cat else self.config
        with self.lock:
            for chunk in self.voice.synthesize(text, syn_config=config, include_alignments=True):
                pcm.append(chunk.audio_int16_bytes)
                for a in chunk.phoneme_alignments or []:
                    phonemes.append([a.phoneme, round(1000 * int(a.num_samples) / rate)])
        audio = b"".join(pcm)
        if not audio:
            return None
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(audio)
        return buf.getvalue(), phonemes or None


class SayTTS:
    def __init__(self, voice: str):
        self.voice = voice
        self.name = f"say · {voice.split(' (')[0]}"

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, None]:
        text = piper_text.plain(text)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "say.wav"
            subprocess.run(
                ["say", "-v", self.voice, "-o", str(out), "--file-format=WAVE", "--data-format=LEI16@22050", "-f", "-"],
                input=text.encode(), check=True, timeout=60, capture_output=True,
            )
            data = out.read_bytes()
        if cat:  # `say` can't slow down: the cat voice will also be a bit faster
            with wave.open(io.BytesIO(data)) as r:
                params, frames = r.getparams(), r.readframes(r.getnframes())
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setparams(params._replace(framerate=round(params.framerate * CAT)))
                w.writeframes(frames)
            data = buf.getvalue()
        return data, None


def say_voices() -> dict[str, list[str]]:
    """This Mac's installed voices by language ("fr", "en"), full names as `say -v` expects them."""
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    found: dict[str, list[str]] = {}
    for m in re.finditer(r"^(.+?)\s+(fr_FR|en_[A-Z]{2})\s", out, re.MULTILINE):
        found.setdefault(m.group(2)[:2], []).append(m.group(1))
    return {k: list(dict.fromkeys(v)) for k, v in found.items()}


class Voices:
    """Eli's voice, switchable live, one per language; the choice is kept in voices/choix.txt (fr), choix.en.txt."""

    def __init__(self, folder: Path, say_voice: str = "", lang: str = "fr", use_say: bool = False):
        self.folder, self.lock, self.say_voice, self.use_say = folder, threading.Lock(), say_voice, use_say
        self.says = say_voices()
        self.busy: str | None = None  # voice being downloaded
        self.cat_file = folder / "chat.txt"
        self.cat = self.cat_file.exists()  # "cat voice" filter
        self.lang = lang
        self.current, self.tts = self._start(lang)

    def _choice_file(self, lang: str) -> Path:
        return self.folder / ("choix.txt" if lang == "fr" else f"choix.{lang}.txt")

    def _say(self, lang: str) -> str:
        """The `say` voice for this language: SAY_VOICE if it speaks it, else a usual one, else the first found."""
        says = self.says.get(lang, [])
        for name in (self.say_voice, SAY_FALLBACK[lang]):
            found = next((s for s in says if s == name or s.startswith(f"{name} (")), None)  # "Samantha (English (US))"
            if found or (name and not says):
                return found or name
        return says[0]

    def wanted(self, lang: str) -> str:
        f = self._choice_file(lang)
        if f.exists():
            return f.read_text().strip()
        return f"say:{self._say(lang)}" if self.use_say else DEFAULT[lang]

    def _start(self, lang: str):
        """(id, tts) for this language without downloading anything: a macOS voice until the model is there."""
        wanted = self.wanted(lang)
        try:
            return wanted, self._load(wanted, download=False)
        except Exception as exc:
            log.warning("voice %s unavailable (%s): macOS voice instead", wanted, exc)
            say = self._say(lang)
            return f"say:{say}", SayTTS(say)

    def set_lang(self, lang: str, switched: Callable[[], None] = lambda: None) -> None:
        """Switch to this language's voice at once (macOS voice if its model is missing), call switched(), then
        download the model if needed (blocking: run it in a thread)."""
        with self.lock:
            if lang != self.lang:
                self.lang = lang
                self.current, self.tts = self._start(lang)
            wanted = self.wanted(lang)
            if self.current != wanted:
                self.busy = wanted
        switched()
        if self.current != wanted:
            self.choose(wanted)

    @property
    def name(self) -> str:
        return self.tts.name

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, list | None] | None:
        """cat: a cat face is shown. The filter only applies to it, and only if it is ticked."""
        return self.tts.synth(text, cat and self.cat)

    def set_cat(self, on: bool) -> None:
        self.cat = on
        if on:
            self.cat_file.write_text("1")
        else:
            self.cat_file.unlink(missing_ok=True)

    def catalog(self) -> dict:
        lang = self.lang
        piper = [{"id": k, "label": v[1], "ready": self._model(k).exists()} for k, v in PIPER.items() if v[0] == lang]
        says = [{"id": f"say:{s}", "label": f"{s.split(' (')[0]} · macOS", "ready": True} for s in self.says.get(lang, [])]
        return {"current": self.current, "busy": self.busy, "cat": self.cat, "lang": lang, "voices": piper + says}

    def choose(self, voice_id: str) -> None:
        """Switch to this voice, downloading it first if needed (blocking: run it in a thread)."""
        if voice_id in PIPER:
            lang = PIPER[voice_id][0]
        else:
            lang = next((k for k, v in self.says.items() if voice_id.startswith("say:") and voice_id[4:] in v), None)
        if lang is None:
            raise ValueError("unknown voice")
        self.busy = voice_id
        try:
            tts = self._load(voice_id, download=True)
        finally:
            self.busy = None
        with self.lock:
            if lang != self.lang:  # the language changed meanwhile: keep the choice, don't install it
                self._choice_file(lang).write_text(voice_id)
                return
            self.current, self.tts = voice_id, tts
        self._choice_file(lang).write_text(voice_id)

    def _model(self, voice_id: str) -> Path:
        return self.folder / (PIPER[voice_id][2].rsplit("/", 1)[1] + ".onnx")

    def _load(self, voice_id: str, download: bool):
        if voice_id.startswith("say:"):
            return SayTTS(voice_id[4:])
        lang, label, remote, speaker = PIPER[voice_id]
        model = self._model(voice_id)
        if not model.exists():
            if not download:
                raise FileNotFoundError(model.name)
            for suffix in (".onnx.json", ".onnx"):
                tmp = model.with_name(model.stem + suffix + ".part")
                log.info("downloading voice %s (%s)…", voice_id, suffix)
                urllib.request.urlretrieve(f"{HF}/{remote}{suffix}", tmp)
                tmp.replace(model.with_name(model.stem + suffix))
        return PiperTTS(model, speaker, f"piper · {label.split(' ·')[0]}")


def make_tts(cfg: dict, root: Path, lang: str = "fr") -> Voices:
    return Voices(root / "voices", cfg["SAY_VOICE"], lang, cfg["TTS"] == "say")

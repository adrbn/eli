"""Synthèse vocale locale, au choix : voix neuronales Piper (téléchargées à la demande) ou voix `say` de macOS.

Le texte peut marquer l'anglais : « j'adore [en]Two People[/en] ». Piper prononce alors ces mots avec les phonèmes
anglais d'espeak, dans la même voix (sinon il les lirait à la française). Chaque synthèse rend (wav, phonèmes) :
les phonèmes et leur durée servent au visage à former les lèvres ; `say` n'en donne pas (None).
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

import piper_text

try:
    from piper import SynthesisConfig
except ImportError:  # sans Piper : seulement les voix `say`
    SynthesisConfig = None

log = logging.getLogger("eli.voice")
CAT = 1.3  # voix de chat : synthèse ralentie d'autant, puis jouée d'autant plus vite → même débit, voix plus aiguë

HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR"
# id → (étiquette, modèle Piper, locuteur). Écoutées et retenues parmi les voix françaises de Piper.
PIPER = {
    "siwis": ("Siwis · femme, claire", "siwis/medium/fr_FR-siwis-medium", None),
    "jessica": ("Jessica · femme, posée", "upmc/medium/fr_FR-upmc-medium", 0),
    "pierre": ("Pierre · homme, posé", "upmc/medium/fr_FR-upmc-medium", 1),
    "tom": ("Tom · homme, jeune", "tom/medium/fr_FR-tom-medium", None),
    "gilles": ("Gilles · homme, grave", "gilles/low/fr_FR-gilles-low", None),
}


class PiperTTS:
    def __init__(self, model: Path, speaker: int | None = None, name: str = ""):
        from piper import PiperVoice  # importé ici : sans Piper installé, `say` prend le relais

        try:  # les alignements (durée de chaque phonème) demandent le paquet onnx
            self.voice = PiperVoice.load(str(model), include_alignments=True)
        except Exception as exc:
            log.warning("pas d'alignements de phonèmes (%s) : la bouche suivra le son seul", exc)
            self.voice = PiperVoice.load(str(model))
        self.config = SynthesisConfig(speaker_id=speaker)
        self.lock = threading.Lock()
        self.name = name or f"piper · {model.stem}"

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, list | None] | None:
        """(wav, [[phonème, durée en ms], …]) ou None si rien n'est prononçable (« … »)."""
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
        if cat:  # `say` ne sait pas ralentir : la voix de chat sera aussi un peu plus rapide
            with wave.open(io.BytesIO(data)) as r:
                params, frames = r.getparams(), r.readframes(r.getnframes())
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setparams(params._replace(framerate=round(params.framerate * CAT)))
                w.writeframes(frames)
            data = buf.getvalue()
        return data, None


def say_voices() -> list[str]:
    """Les voix françaises installées sur ce Mac (noms complets, tels que `say -v` les attend)."""
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return list(dict.fromkeys(m.group(1) for m in re.finditer(r"^(.+?)\s+fr_FR\s", out, re.MULTILINE)))


class Voices:
    """La voix d'Eli, changeable à chaud ; le choix est gardé dans voices/choix.txt."""

    def __init__(self, folder: Path, default: str, fallback_say: str):
        self.folder, self.lock = folder, threading.Lock()
        self.choice_file = folder / "choix.txt"
        self.says = say_voices()
        self.busy: str | None = None  # voix en cours de téléchargement
        self.cat_file = folder / "chat.txt"
        self.cat = self.cat_file.exists()  # filtre « voix de chat »
        wanted = self.choice_file.read_text().strip() if self.choice_file.exists() else default
        try:
            self.current, self.tts = wanted, self._load(wanted, download=False)
        except Exception as exc:
            log.warning("voix %s indisponible (%s) : voix macOS à la place", wanted, exc)
            self.current, self.tts = f"say:{fallback_say}", SayTTS(fallback_say)

    @property
    def name(self) -> str:
        return self.tts.name

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, list | None] | None:
        """cat : un visage de chat est affiché. Le filtre ne s'applique qu'à lui, et seulement s'il est coché."""
        return self.tts.synth(text, cat and self.cat)

    def set_cat(self, on: bool) -> None:
        self.cat = on
        if on:
            self.cat_file.write_text("1")
        else:
            self.cat_file.unlink(missing_ok=True)

    def catalog(self) -> dict:
        piper = [{"id": k, "label": v[0], "ready": self._model(k).exists()} for k, v in PIPER.items()]
        says = [{"id": f"say:{s}", "label": f"{s.split(' (')[0]} · macOS", "ready": True} for s in self.says]
        return {"current": self.current, "busy": self.busy, "cat": self.cat, "voices": piper + says}

    def choose(self, voice_id: str) -> None:
        """Bascule sur cette voix, en la téléchargeant d'abord s'il le faut (bloquant : à lancer dans un fil)."""
        if voice_id not in PIPER and not (voice_id.startswith("say:") and voice_id[4:] in self.says):
            raise ValueError("voix inconnue")
        self.busy = voice_id
        try:
            tts = self._load(voice_id, download=True)
        finally:
            self.busy = None
        with self.lock:
            self.current, self.tts = voice_id, tts
        self.choice_file.write_text(voice_id)

    def _model(self, voice_id: str) -> Path:
        return self.folder / (PIPER[voice_id][1].rsplit("/", 1)[1] + ".onnx")

    def _load(self, voice_id: str, download: bool):
        if voice_id.startswith("say:"):
            return SayTTS(voice_id[4:])
        label, remote, speaker = PIPER[voice_id]
        model = self._model(voice_id)
        if not model.exists():
            if not download:
                raise FileNotFoundError(model.name)
            for suffix in (".onnx.json", ".onnx"):
                tmp = model.with_name(model.stem + suffix + ".part")
                log.info("téléchargement de la voix %s (%s)…", voice_id, suffix)
                urllib.request.urlretrieve(f"{HF}/{remote}{suffix}", tmp)
                tmp.replace(model.with_name(model.stem + suffix))
        return PiperTTS(model, speaker, f"piper · {label.split(' ·')[0]}")


def make_tts(cfg: dict, root: Path) -> Voices:
    default = {"say": f"say:{cfg['SAY_VOICE']}"}.get(cfg["TTS"], "siwis")
    return Voices(root / "voices", default, cfg["SAY_VOICE"])

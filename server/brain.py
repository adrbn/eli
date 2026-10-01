"""Le cerveau : micro → texte (Écho, puis Groq) → réponse (Groq, en flux) → voix → clips pour le visage.

Il ne parle au visage que par le protocole de l'écran (POST /clip, POST /state), exactement comme il
le fera avec l'ESP32 : changer FACE_URL suffira.
"""
from __future__ import annotations

import json
import logging
import random
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Iterator

import meow
import piper_text
from memory import Memory

log = logging.getLogger("eli.brain")

GROQ = "https://api.groq.com/openai/v1"
UA = "eli/0.1"  # le User-Agent par défaut de urllib se fait parfois bloquer par Cloudflare

DEFAULT_PERSONA = (
    "Tu es Eli, un petit visage robot : un écran vert sur noir qui parle et qui chante. "
    "Tu tutoies la personne en face de toi. "
    "Tu réponds en français, comme à l'oral : une à trois phrases courtes, chaleureuses et directes, "
    "avec une pointe d'humour quand ça s'y prête. Tout ce que tu écris est lu à voix haute : "
    "pas de listes, pas de markdown, pas d'emoji, pas de symboles, pas d'URL. "
    "Si tu ne sais pas, dis-le simplement."
)

# Ajouté à toute personnalité (même PERSONA_FILE) : la voix française lit sinon l'anglais à la française.
LANG_HINT = (
    "Quand tu dis des mots anglais (titres de morceaux, noms d'artistes, expressions), entoure-les de [en] et [/en], "
    "par exemple : j'adore [en]Bohemian Rhapsody[/en] de Queen. Jamais pour des mots français."
)
INTRO_GREETING = (
    "Salut ! Moi c'est Eli. On ne se connaît pas encore, alors j'aimerais te poser quelques questions, "
    "pour apprendre à te connaître. Pour commencer : comment tu t'appelles ?"
)
INTRO_QUESTIONS = 5


def intro_hint(left: int) -> str:
    if left > 1:
        return (f"Vous êtes en train de faire connaissance (il reste {left - 1} questions). Réagis à sa réponse en une "
                "phrase chaleureuse, puis pose UNE seule question pour mieux le connaître, une que tu n'as pas déjà "
                "posée : ce qu'il fait dans la vie, la musique qu'il aime, ce qui le fait rire ou le passionne, "
                "comment il aimerait que tu sois avec lui (taquin, doux, direct…).")
    return ("C'était la dernière réponse des présentations : réagis-y, puis dis en une phrase que tu as tout noté "
            "et que tu es content de le connaître. Ne pose plus de question.")


# Whisper invente ces phrases sur du silence ; Parakeet beaucoup moins, mais autant filtrer.
_HALLUCINATIONS = re.compile(
    r"amara\.org|sous-titr|merci d'avoir regardé|abonnez-vous|^\W*$", re.IGNORECASE
)
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️‍]")
_END = re.compile(r"([.!?…]+[\"»)\]]*)\s+")
_ABBR = {"m", "mm", "mme", "mlle", "dr", "pr", "st", "ste", "cf", "ex", "vs", "p", "av", "bd"}


def clean_for_tts(text: str) -> str:
    """Retire ce qui ne se prononce pas : markdown, puces, emoji, liens."""
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\s*(?:[-•*]|\d+[.)])\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_`#>|~]+", "", _EMOJI.sub("", text))
    return re.sub(r"\s+", " ", text).strip()


class SentenceSplitter:
    """Découpe un texte qui arrive en flux en phrases, pour lancer la voix dès la première."""

    def __init__(self, soft: int = 160):
        self.buf = ""
        self.soft = soft

    def feed(self, delta: str) -> list[str]:
        self.buf += delta
        out, start = [], 0
        for m in _END.finditer(self.buf):
            word = re.search(r"[\w°]+$", self.buf[start:m.start(1)])
            if m.group(1) == "." and word and word.group(0).lower() in _ABBR:
                continue
            out.append(self.buf[start:m.end(1)].strip())
            start = m.end()
        self.buf = self.buf[start:]
        if len(self.buf) > self.soft:  # phrase interminable : on coupe à la dernière virgule
            cut = max(self.buf.rfind(sep, 0, self.soft) for sep in (", ", "; ", ": "))
            if cut >= 40:
                out.append(self.buf[:cut + 1].strip())
                self.buf = self.buf[cut + 2:]
        return [s for s in out if s]

    def flush(self) -> list[str]:
        rest, self.buf = self.buf.strip(), ""
        return [rest] if rest else []


def multipart(fields: dict, filename: str, data: bytes, ctype: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ]
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def transcribe(url: str, key: str, model: str, language: str, wav: bytes, timeout: float) -> str:
    """Appel au format OpenAI /audio/transcriptions (Écho et Groq parlent le même)."""
    fields = {"model": model}
    if language:
        fields["language"] = language
    body, ctype = multipart(fields, "micro.wav", wav, "audio/wav")
    headers = {"Content-Type": ctype, "User-Agent": UA}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return str(json.loads(r.read()).get("text", "")).strip()


def stream_chat(key: str, model: str, messages: list[dict], timeout: float = 30, max_tokens: int = 700) -> Iterator[str]:
    body: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.7,
        "max_completion_tokens": max_tokens,
    }
    if model.startswith("openai/gpt-oss"):
        body.update(reasoning_effort="low", include_reasoning=False)
    req = urllib.request.Request(
        f"{GROQ}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                delta = json.loads(data)["choices"][0]["delta"].get("content")
            except (KeyError, IndexError, ValueError, TypeError):
                continue
            if delta:
                yield delta


class FaceClient:
    """Parle au visage par HTTP, comme le fera le cerveau avec l'ESP32."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def _post(self, path: str, body: bytes, ctype: str, headers: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base + path, data=body, headers={"Content-Type": ctype, **(headers or {})}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")

    def clip(self, wav: bytes, kind: str, text: str, turn: int, phonemes: list | None = None) -> dict:
        query = urllib.parse.urlencode({"kind": kind, "turn": turn})
        headers = {"X-Text": urllib.parse.quote(text[:500])}
        packed = urllib.parse.quote(json.dumps(phonemes, ensure_ascii=False, separators=(",", ":"))) if phonemes else ""
        if packed and len(packed) < 7000:  # une en-tête HTTP a ses limites ; au-delà, la bouche suit le son seul
            headers["X-Phonemes"] = packed
        return self._post(f"/clip?{query}", wav, "audio/wav", headers)

    def state(self, mode: str) -> None:
        try:
            self._post("/state", json.dumps({"mode": mode}).encode(), "application/json")
        except OSError as exc:
            log.warning("visage injoignable pour /state : %s", exc)

    def stop(self, turn: int) -> None:
        """Nouveau tour : le visage se tait et ignorera les clips des tours précédents encore en route."""
        try:
            self._post("/stop", json.dumps({"turn": turn}).encode(), "application/json")
        except OSError as exc:
            log.warning("visage injoignable pour /stop : %s", exc)


class Brain:
    def __init__(self, cfg: dict, tts, face: FaceClient, publish: Callable[[str, dict], None],
                 theme: Callable[[], str | None] = lambda: None):
        self.cfg, self.tts, self.face, self.publish, self.theme = cfg, tts, face, publish, theme
        self.intro_left = 0  # questions de présentation encore à poser
        self.lock = threading.Lock()
        self.turn = 0
        self.logged = 0  # dernier tour écrit dans l'historique
        self.memory = Memory(Path(cfg["MEMORY_DIR"]) if cfg.get("MEMORY_DIR") else None, self._digest)
        persona_file = Path(cfg.get("PERSONA_FILE") or "")
        self.persona = persona_file.read_text("utf-8").strip() if persona_file.is_file() else DEFAULT_PERSONA

    # --- tours de parole -------------------------------------------------------------------
    def _new_turn(self) -> int:
        with self.lock:
            self.turn += 1
            return self.turn

    def alive(self, turn: int) -> bool:
        return turn == self.turn

    def cancel(self) -> None:
        """Un nouveau tour rend tous les précédents caducs : ils s'arrêtent à leur prochaine étape."""
        self._new_turn()

    def reset(self, everything: bool = False) -> None:
        self.intro_left = 0
        self.memory.forget(everything)

    def intro(self) -> int:
        """Premières présentations : Eli pose quelques questions, une par réponse, et retient tout."""
        self.intro_left = INTRO_QUESTIONS
        self.memory.add("(C'est notre première rencontre.)", INTRO_GREETING)
        return self.start("speak", INTRO_GREETING)

    def cat(self) -> bool:
        """Un visage de chat : miaous dans les réponses, et voix de chat si le filtre est coché."""
        return str(self.theme() or "").startswith("chat")

    def _digest(self, messages: list[dict]) -> str:
        """Appel non diffusé au LLM, pour le carnet de souvenirs."""
        if not self.cfg.get("GROQ_API_KEY"):
            raise RuntimeError("pas de clé Groq")
        return "".join(stream_chat(self.cfg["GROQ_API_KEY"], self.cfg["LLM_MODEL"], messages, timeout=60, max_tokens=2500))

    def start(self, kind: str, payload) -> int:
        turn = self._new_turn()
        threading.Thread(target=self._run, args=(turn, kind, payload), daemon=True).start()
        return turn

    def _run(self, turn: int, kind: str, payload) -> None:
        try:
            self.face.stop(turn)
            if kind == "speak":
                self._say(turn, clean_for_tts(payload), [])
                return
            if kind == "meow":
                self._meow(turn)
                return
            self.face.state("think")
            text = payload if kind == "chat" else self._hear(turn, payload)
            if text and self.alive(turn):
                self._answer(turn, text)
        except Exception as exc:  # une panne ne doit jamais laisser le visage figé en « réflexion »
            log.exception("tour %s en échec", turn)
            if self.alive(turn):
                self.publish("brain", {"stage": "error", "error": str(exc)[:300]})
                self._say(turn, "Oups, mon cerveau ne répond pas pour l'instant.", [])
        finally:
            if self.alive(turn):
                self.face.state("idle")

    # --- oreilles ----------------------------------------------------------------------------
    def _hear(self, turn: int, wav: bytes) -> str:
        self.publish("brain", {"stage": "stt"})
        text, provider = self.transcribe(wav)
        if _HALLUCINATIONS.search(text):
            text = ""
        if not self.alive(turn):
            return ""
        self.publish("brain", {"stage": "heard", "text": text, "provider": provider})
        return text

    def transcribe(self, wav: bytes) -> tuple[str, str]:
        cfg, errors = self.cfg, []
        for provider in [p.strip() for p in cfg["STT_PROVIDERS"].split(",") if p.strip()]:
            try:
                if provider == "echo" and cfg.get("ECHO_URL"):
                    url = cfg["ECHO_URL"].rstrip("/") + "/v1/audio/transcriptions"
                    return transcribe(url, cfg.get("ECHO_API_KEY", ""), "parakeet", cfg["STT_LANGUAGE"], wav, 12), "echo"
                if provider == "groq" and cfg.get("GROQ_API_KEY"):
                    url = f"{GROQ}/audio/transcriptions"
                    return transcribe(url, cfg["GROQ_API_KEY"], cfg["GROQ_STT_MODEL"], cfg["STT_LANGUAGE"], wav, 20), "groq"
            except (urllib.error.URLError, OSError, ValueError) as exc:
                log.warning("STT %s en échec : %s", provider, exc)
                errors.append(f"{provider}: {exc}")
        raise RuntimeError("aucune transcription possible (" + "; ".join(errors or ["aucun moteur configuré"]) + ")")

    # --- bouche ------------------------------------------------------------------------------
    def _answer(self, turn: int, user_text: str) -> None:
        if not self.cfg.get("GROQ_API_KEY"):
            self._say(turn, "Je n'ai pas encore de cerveau branché : il manque la clé Groq.", [])
            return
        self.publish("brain", {"stage": "llm"})
        system = f"{self.memory.system_prompt(self.persona)}\n\n{LANG_HINT}"
        intro = self.intro_left
        if intro:
            system += "\n\n" + intro_hint(intro)
        messages = [{"role": "system", "content": system}, *self.memory.recent(), {"role": "user", "content": user_text}]
        cat = self.cat()
        meows = 0
        if cat and random.random() < 0.35:
            meows += 1
            self._meow(turn)
        splitter, said = SentenceSplitter(), []
        for delta in self.reply_stream(messages):
            if not self.alive(turn):
                break
            for sentence in splitter.feed(delta):
                self._say(turn, clean_for_tts(sentence), said)
                if cat and meows < 2 and random.random() < 0.2:  # un miaou glissé entre deux phrases
                    meows += 1
                    self._meow(turn)
        else:
            for sentence in splitter.flush():
                self._say(turn, clean_for_tts(sentence), said)
            if cat and not meows and random.random() < 0.5:
                self._meow(turn)
        reply = " ".join(said)
        if intro and self.alive(turn):
            self.intro_left = intro - 1
            if not self.intro_left:  # fin des présentations : on range le carnet sans attendre
                threading.Thread(target=self.memory.consolidate, daemon=True).start()
        with self.lock:  # même coupée, la réponse a été entendue : elle compte, sauf si un tour plus récent a déjà écrit
            if turn > self.logged:
                self.logged = turn
                self.memory.add(user_text, reply or "…")
        if self.alive(turn):
            self.publish("brain", {"stage": "done", "text": reply})

    def reply_stream(self, messages: list[dict]) -> Iterator[str]:
        last: Exception | None = None
        for model in [m for m in (self.cfg["LLM_MODEL"], self.cfg.get("LLM_FALLBACK_MODEL")) if m]:
            got = False
            try:
                for delta in stream_chat(self.cfg["GROQ_API_KEY"], model, messages):
                    got = True
                    yield delta
                return
            except (urllib.error.URLError, OSError) as exc:  # HTTPError (429, 5xx…) en fait partie
                if got:
                    raise
                log.warning("LLM %s en échec : %s", model, exc)
                last = exc
        raise RuntimeError(f"LLM indisponible : {last}")

    def _say(self, turn: int, text: str, said: list[str]) -> None:
        if not text or not self.alive(turn):
            return
        spoken = self.tts.synth(text, self.cat())
        if spoken and self.alive(turn):  # None : rien de prononçable (« … »)
            wav, phonemes = spoken
            shown = piper_text.plain(text)
            self.face.clip(wav, "speech", shown, turn, phonemes)
            said.append(shown)

    def _meow(self, turn: int) -> None:
        if self.alive(turn):
            self.face.clip(meow.wav(), "speech", "Miaou !", turn)

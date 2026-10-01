"""The brain: mic → text (Echo, then Groq) → answer (Groq, streamed) → voice → clips for the face.

It only talks to the face through the screen protocol (POST /clip, POST /state), exactly as it
will with the ESP32: changing FACE_URL will be enough.
"""
from __future__ import annotations

import datetime
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

import brief
import meow
import piper_text
import tags
from navidrome import MusicError
from memory import Memory

log = logging.getLogger("eli.brain")

GROQ = "https://api.groq.com/openai/v1"
UA = "eli/0.1"  # urllib's default User-Agent sometimes gets blocked by Cloudflare

DEFAULT_PERSONA = {
    "fr": (
        "Tu es Eli, un petit visage robot : un écran vert sur noir qui parle et qui chante. "
        "Tu tutoies la personne en face de toi. "
        "Tu réponds en français, comme à l'oral : une à trois phrases courtes, chaleureuses et directes, "
        "avec une pointe d'humour quand ça s'y prête. Tout ce que tu écris est lu à voix haute : "
        "pas de listes, pas de markdown, pas d'emoji, pas de symboles, pas d'URL. "
        "Si tu ne sais pas, dis-le simplement."
    ),
    "en": (
        "You are Eli, a little robot face: a green-on-black screen that talks and sings. "
        "You speak casually to the person in front of you. "
        "You answer in English, the way people talk: one to three short sentences, warm and direct, "
        "with a touch of humour when it fits. Everything you write is read aloud: "
        "no lists, no markdown, no emoji, no symbols, no URLs. "
        "If you don't know, just say so."
    ),
}

# Added to any persona (even PERSONA_FILE). French: the French voice would read English the French way otherwise.
LANG_HINT = {
    "fr": ("Quand tu dis des mots anglais (titres de morceaux, noms d'artistes, expressions), entoure-les de [en] et "
           "[/en], par exemple : j'adore [en]Bohemian Rhapsody[/en] de Queen. Jamais pour des mots français."),
    "en": "Always answer in English, whatever the language of the persona above.",
}
INTRO_GREETING = {
    "fr": ("Salut ! Moi c'est Eli. On ne se connaît pas encore, alors j'aimerais te poser quelques questions, "
           "pour apprendre à te connaître. Pour commencer : comment tu t'appelles ?"),
    "en": ("Hi! I'm Eli. We don't know each other yet, so I'd like to ask you a few questions "
           "to get to know you. To start: what's your name?"),
}
INTRO_MARKER = {"fr": "(C'est notre première rencontre.)", "en": "(This is our first meeting.)"}
INTRO_QUESTIONS = 5

# Before a song he picked from the library: covers the seconds the vocal track needs to start. {artist} lines are skipped
# when the song has none.
SONG_INTROS = {
    "fr": ("Voici {title}, de {artist}.", "Allez, {title}, de {artist} !", "Un peu de {artist} : {title}.",
           "C'est parti pour {title} !", "On enchaîne avec {title}, de {artist}.", "Voici {title}."),
    "en": ("Here's {title}, by {artist}.", "Let's go: {title}, by {artist}!", "A bit of {artist}: {title}.",
           "Here we go, {title}!", "Up next, {title}, by {artist}.", "Here's {title}."),
}
HISTORY = 50  # songs remembered for "previous"

# Everything Eli says without the LLM.
LINES = {
    "fr": {
        "oops": "Oups, mon cerveau ne répond pas pour l'instant.",
        "no_brain": "Je n'ai pas encore de cerveau branché : il manque la clé Groq, ou l'adresse d'un LLM local.",
        "need_music": "Pour ça, il me faut l'accès à ta bibliothèque Navidrome. Je t'ouvre le formulaire.",
        "not_found": "Je n'ai rien trouvé pour ça dans ta bibliothèque.",
        "music_down": "Je n'arrive pas à joindre ta musique.",
        "new_voice": "Voilà ma nouvelle voix. Elle te plaît ?",
        "cat_on": "Miaou ! Voilà ma voix de chat.",
        "cat_off": "Je reprends ma voix normale.",
        "meow": "Miaou !",
    },
    "en": {
        "oops": "Oops, my brain isn't answering right now.",
        "no_brain": "I don't have a brain plugged in yet: the Groq key is missing, or the address of a local LLM.",
        "need_music": "For that, I need access to your Navidrome library. I'm opening the form for you.",
        "not_found": "I couldn't find anything for that in your library.",
        "music_down": "I can't reach your music.",
        "new_voice": "Here's my new voice. Do you like it?",
        "cat_on": "Meow! Here's my cat voice.",
        "cat_off": "Back to my normal voice.",
        "meow": "Meow!",
    },
}


def intro_hint(left: int, lang: str = "fr") -> str:
    if lang == "en":
        if left > 1:
            return (f"You're getting to know each other ({left - 1} questions left). React to their answer in one warm "
                    "sentence, then ask ONE question to know them better, one you haven't asked yet: what they do, "
                    "the music they like, what makes them laugh or what they love, how they'd like you to be with "
                    "them (teasing, gentle, direct…).")
        return ("That was the last answer of the introductions: react to it, then say in one sentence that you've "
                "noted everything and you're glad to know them. Don't ask any more questions.")
    if left > 1:
        return (f"Vous êtes en train de faire connaissance (il reste {left - 1} questions). Réagis à sa réponse en une "
                "phrase chaleureuse, puis pose UNE seule question pour mieux le connaître, une que tu n'as pas déjà "
                "posée : ce qu'il fait dans la vie, la musique qu'il aime, ce qui le fait rire ou le passionne, "
                "comment il aimerait que tu sois avec lui (taquin, doux, direct…).")
    return ("C'était la dernière réponse des présentations : réagis-y, puis dis en une phrase que tu as tout noté "
            "et que tu es content de le connaître. Ne pose plus de question.")


# Whisper makes these up on silence; Parakeet much less, but better filter them.
_HALLUCINATIONS = re.compile(
    r"amara\.org|sous-titr|merci d'avoir regardé|abonnez-vous|thanks? (you )?for watching|^\W*$", re.IGNORECASE
)
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️‍]")
_END = re.compile(r"([.!?…]+[\"»)\]]*)\s+")
_ABBR = {"m", "mm", "mme", "mlle", "dr", "pr", "st", "ste", "cf", "ex", "vs", "p", "av", "bd", "mr", "mrs", "ms", "jr", "sr"}


def clean_for_tts(text: str) -> str:
    """Strips what can't be said: markdown, bullets, emoji, links."""
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\s*(?:[-•*]|\d+[.)])\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_`#>|~]+", "", _EMOJI.sub("", text))
    return re.sub(r"\s+", " ", text).strip()


class SentenceSplitter:
    """Cuts streamed text into sentences, to start the voice from the first one."""

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
        if len(self.buf) > self.soft:  # endless sentence: cut at the last comma
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
    """OpenAI-style /audio/transcriptions call (Echo and Groq speak the same)."""
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


def stream_chat(key: str, model: str, messages: list[dict], timeout: float = 30, max_tokens: int = 700,
                base: str = GROQ) -> Iterator[str]:
    body: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.7,
        "max_completion_tokens": max_tokens,
    }
    if model.startswith("openai/gpt-oss"):
        body.update(reasoning_effort="low", include_reasoning=False)
    if "qwen3" in model.lower():  # no thinking out loud: we want the answer right away
        body["chat_template_kwargs"] = {"enable_thinking": False}
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(
        f"{base.rstrip('/')}/chat/completions",
        data=json.dumps(body).encode(),
        headers=headers,
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
    """Talks to the face over HTTP, as the brain will with the ESP32."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def _post(self, path: str, body: bytes, ctype: str, headers: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base + path, data=body, headers={"Content-Type": ctype, **(headers or {})}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")

    def clip(self, wav: bytes, kind: str, text: str, turn: int, phonemes: list | None = None, mood: str | None = None,
             ctype: str = "audio/wav", name: str | None = None, genre: str | None = None) -> dict:
        query = urllib.parse.urlencode({"kind": kind, "turn": turn, **({"name": name} if name else {})})
        headers = {"X-Text": urllib.parse.quote(text[:500])}
        if mood:
            headers["X-Mood"] = urllib.parse.quote(mood)
        if genre:
            headers["X-Genre"] = urllib.parse.quote(genre[:60])
        packed = urllib.parse.quote(json.dumps(phonemes, ensure_ascii=False, separators=(",", ":"))) if phonemes else ""
        if packed and len(packed) < 7000:  # an HTTP header has limits; beyond, the mouth follows the sound only
            headers["X-Phonemes"] = packed
        return self._post(f"/clip?{query}", wav, ctype, headers)

    def state(self, mode: str) -> None:
        try:
            self._post("/state", json.dumps({"mode": mode}).encode(), "application/json")
        except OSError as exc:
            log.warning("face unreachable for /state: %s", exc)

    def stop(self, turn: int) -> None:
        """New turn: the face goes quiet and will ignore clips from earlier turns still on their way."""
        try:
            self._post("/stop", json.dumps({"turn": turn}).encode(), "application/json")
        except OSError as exc:
            log.warning("face unreachable for /stop: %s", exc)


class Brain:
    def __init__(self, cfg: dict, tts, face: FaceClient, publish: Callable[[str, dict], None],
                 theme: Callable[[], str | None] = lambda: None, music=None, lang: Callable[[], str] = lambda: "fr"):
        self.cfg, self.tts, self.face, self.publish, self.theme, self.music = cfg, tts, face, publish, theme, music
        self.lang = lang  # "fr" or "en", what the page asked for (POST /lang)
        self.intro_left = 0  # introduction questions still to ask
        self.lock = threading.Lock()
        self.turn = 0
        self.song = 0
        self.played: list[dict] = []  # the songs sung, for previous / next
        self.place = -1  # the latest song asked for: only a newer one or a real stop drops it (not a new sentence)
        self.logged = 0  # last turn written to the history
        self.memory = Memory(Path(cfg["MEMORY_DIR"]) if cfg.get("MEMORY_DIR") else None, self._digest, lang=lang)
        persona_file = Path(cfg.get("PERSONA_FILE") or "")
        self.persona = persona_file.read_text("utf-8").strip() if persona_file.is_file() else None

    def line(self, key: str) -> str:
        """A fixed sentence (LINES) in the current language."""
        return LINES[self.lang()][key]

    # --- speaking turns ----------------------------------------------------------------------
    def _new_turn(self) -> int:
        with self.lock:
            self.turn += 1
            return self.turn

    def alive(self, turn: int) -> bool:
        return turn == self.turn

    def cancel(self, keep: str | None = None) -> None:
        """A new turn makes all earlier ones stale: they stop at their next step. keep="music": a song on its way still comes."""
        self._new_turn()
        if keep != "music":
            self.drop_song()

    def drop_song(self) -> int:
        with self.lock:
            self.song += 1
            return self.song

    def reset(self, everything: bool = False) -> None:
        self.intro_left = 0
        self.memory.forget(everything)

    def intro(self) -> int:
        """First introductions: Eli asks a few questions, one per answer, and remembers everything."""
        self.intro_left, lang = INTRO_QUESTIONS, self.lang()
        self.memory.add(INTRO_MARKER[lang], INTRO_GREETING[lang])
        return self.start("speak", INTRO_GREETING[lang])

    def brief(self) -> int:
        """The morning brief (see brief.py)."""
        return self.start("brief", None)

    def quick(self, messages: list[dict]) -> str:
        """A small question to the LLM, whole answer (a song's genre)."""
        if not self.has_llm():
            raise RuntimeError("no LLM")
        return "".join(stream_chat(self._llm_key(), self.cfg["LLM_MODEL"], messages, timeout=15, max_tokens=300,
                                   base=self.cfg.get("LLM_URL") or GROQ))

    def has_llm(self) -> bool:
        return bool(self.cfg.get("LLM_URL") or self.cfg.get("GROQ_API_KEY"))

    def _llm_key(self) -> str:
        return self.cfg.get("LLM_API_KEY", "") if self.cfg.get("LLM_URL") else self.cfg.get("GROQ_API_KEY", "")

    def cat(self) -> bool:
        """A cat face: meows in the answers, and a cat voice if the filter is ticked."""
        return str(self.theme() or "").startswith("chat")

    def _digest(self, messages: list[dict]) -> str:
        """Non-streamed LLM call, for the memory notebook."""
        if not self.has_llm():
            raise RuntimeError("no Groq key")
        return "".join(stream_chat(self._llm_key(), self.cfg["LLM_MODEL"], messages, timeout=60, max_tokens=2500,
                                   base=self.cfg.get("LLM_URL") or GROQ))

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
            if kind == "brief":
                text = brief.prompt(datetime.datetime.now(), self.cfg.get("BRIEF_CITY", ""), self.lang())
            else:
                text = payload if kind == "chat" else self._hear(turn, payload)
            if text and self.alive(turn):
                self._answer(turn, text)
        except Exception as exc:  # a failure must never leave the face stuck "thinking"
            log.exception("turn %s failed", turn)
            if self.alive(turn):
                self.publish("brain", {"stage": "error", "error": str(exc)[:300]})
                self._say(turn, self.line("oops"), [])
        finally:
            if self.alive(turn):
                self.face.state("idle")

    # --- ears ---------------------------------------------------------------------------------
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
        language = cfg["STT_LANGUAGE"] or self.lang()  # empty: follows the language
        for provider in [p.strip() for p in cfg["STT_PROVIDERS"].split(",") if p.strip()]:
            try:
                if provider == "echo" and cfg.get("ECHO_URL"):
                    url = cfg["ECHO_URL"].rstrip("/") + "/v1/audio/transcriptions"
                    return transcribe(url, cfg.get("ECHO_API_KEY", ""), "parakeet", language, wav, 12), "echo"
                if provider == "groq" and cfg.get("GROQ_API_KEY"):
                    url = f"{GROQ}/audio/transcriptions"
                    return transcribe(url, cfg["GROQ_API_KEY"], cfg["GROQ_STT_MODEL"], language, wav, 20), "groq"
            except (urllib.error.URLError, OSError, ValueError) as exc:
                log.warning("STT %s failed: %s", provider, exc)
                errors.append(f"{provider}: {exc}")
        raise RuntimeError("no transcription possible (" + "; ".join(errors or ["no engine configured"]) + ")")

    # --- mouth --------------------------------------------------------------------------------
    def _answer(self, turn: int, user_text: str) -> None:
        if not self.has_llm():
            self._say(turn, self.line("no_brain"), [])
            return
        self.publish("brain", {"stage": "llm"})
        lang = self.lang()
        persona = self.persona or DEFAULT_PERSONA[lang]
        system = f"{self.memory.system_prompt(persona)}\n\n{LANG_HINT[lang]}\n\n{tags.HINT[lang]}"
        intro = self.intro_left
        if intro:
            system += "\n\n" + intro_hint(intro, lang)
        messages = [{"role": "system", "content": system}, *self.memory.recent(), {"role": "user", "content": user_text}]
        cat = self.cat()
        meows = 0
        if cat and random.random() < 0.35:
            meows += 1
            self._meow(turn)
        splitter, said, songs = SentenceSplitter(), [], []
        for delta in self.reply_stream(messages):
            if not self.alive(turn):
                break
            for sentence in splitter.feed(delta):
                self._sentence(turn, sentence, said, songs)
                if cat and meows < 2 and random.random() < 0.2:  # a meow slipped between two sentences
                    meows += 1
                    self._meow(turn)
        else:
            for sentence in splitter.flush():
                self._sentence(turn, sentence, said, songs)
            if cat and not meows and random.random() < 0.5:
                self._meow(turn)
        reply = " ".join(said)
        if intro and self.alive(turn):
            self.intro_left = intro - 1
            if not self.intro_left:  # end of the introductions: file the notebook right away
                threading.Thread(target=self.memory.consolidate, daemon=True).start()
        with self.lock:  # even cut short, the answer was heard: it counts, unless a newer turn already wrote
            if turn > self.logged:
                self.logged = turn
                self.memory.add(user_text, reply or "…")
        if self.alive(turn):
            self.publish("brain", {"stage": "done", "text": reply})
        if songs and self.alive(turn):
            self._play(turn, songs[-1])

    def reply_stream(self, messages: list[dict]) -> Iterator[str]:
        last: Exception | None = None
        for model in [m for m in (self.cfg["LLM_MODEL"], self.cfg.get("LLM_FALLBACK_MODEL")) if m]:
            got = False
            try:
                for delta in stream_chat(self._llm_key(), model, messages, base=self.cfg.get("LLM_URL") or GROQ):
                    got = True
                    yield delta
                return
            except (urllib.error.URLError, OSError) as exc:  # includes HTTPError (429, 5xx…)
                if got:
                    raise
                log.warning("LLM %s failed: %s", model, exc)
                last = exc
        raise RuntimeError(f"LLM unavailable: {last}")

    def _sentence(self, turn: int, sentence: str, said: list[str], songs: list[str]) -> None:
        text, mood, song = tags.parse(sentence)
        if song:
            songs.append(song)
        self._say(turn, clean_for_tts(text), said, mood)

    def _say(self, turn: int, text: str, said: list[str], mood: str | None = None) -> None:
        if not text or not self.alive(turn):
            return
        spoken = self.tts.synth(text, self.cat())
        if spoken and self.alive(turn):  # None: nothing pronounceable ("…")
            wav, phonemes = spoken
            shown = piper_text.plain(text)
            self.face.clip(wav, "speech", shown, turn, phonemes, mood)
            said.append(shown)

    def _play(self, turn: int, query: str) -> None:
        """[music: …]: finds the song in the library and sends it to the face, which sings it."""
        if not self.music or not self.music.auth:  # the page opens the form at the right place
            self.publish("setup", {"need": "navidrome"})
            self._say(turn, self.line("need_music"), [])
            return
        self.publish("brain", {"stage": "music", "text": query})
        try:
            song = self.music.find(query)
            if not song:
                self._say(turn, self.line("not_found"), [], "gêne")
                return
            self.publish("brain", {"stage": "fetch", "text": f"{song['artist']} – {song['title']}".strip(" –")})
            self.sing(song)
        except MusicError as exc:
            self.publish("brain", {"stage": "error", "error": str(exc)})
            self._say(turn, self.line("music_down"), [], "tristesse")

    def sing(self, song: dict, announce: bool = False, remember: bool = True) -> None:
        """Streams a library song to the face, which sings it. The download takes seconds: talking over it or cutting
        his speech (Esc) must not lose it, only a real stop or another song does. Sent as turn 0 so no turn outdates it.
        announce: he says its name first (the picker; the LLM has already said something)."""
        ticket = self.drop_song()
        if remember:
            with self.lock:
                self.played = [*self.played[: self.place + 1], song][-HISTORY:]
                self.place = len(self.played) - 1
        data = self.music.fetch(song["id"])
        if ticket != self.song:
            return
        if announce:
            self._announce(song)
        title = f"{song['artist']} – {song['title']}".strip(" –")
        self.face.clip(data, "music", title, 0, ctype="audio/mpeg", name=f"{title[:100]}.mp3", genre=song.get("genre"))

    def _announce(self, song: dict) -> None:
        lines = [x for x in SONG_INTROS[self.lang()] if song.get("artist") or "{artist}" not in x]
        text = random.choice(lines).format(title=song.get("title") or "", artist=song.get("artist") or "")
        try:  # a silent TTS must not cost the song
            spoken = self.tts.synth(text, self.cat())
        except Exception as exc:  # noqa: BLE001
            log.warning("song intro: %s", exc)
            return
        if spoken:
            self.face.clip(spoken[0], "speech", piper_text.plain(text), 0, spoken[1], "joie")

    def step(self, delta: int) -> tuple[dict | None, bool]:
        """Previous (-1) / next (+1): back and forth through the songs sung, then a random one past the end.
        Previous on the first song starts it again. Returns (song, new: whether to add it to the history)."""
        with self.lock:
            i = self.place + delta
            if 0 <= i < len(self.played):
                self.place = i
                return self.played[i], False
            current = self.played[self.place] if self.played else None
        if delta < 0:
            return current, False
        now = current["id"] if current else None
        return next((x for x in self.music.songs("") if x["id"] != now), None), True

    def _meow(self, turn: int) -> None:
        if self.alive(turn):
            self.face.clip(meow.wav(), "speech", self.line("meow"), turn)

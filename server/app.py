"""Eli — local server for the face simulator.

Role 1 · the screen. Same protocol as the ESP32 later; the web page is just one display of it:
  POST /clip?kind=speech|music&turn=N&name=f.mp3   body = audio file, header X-Text (spoken text, URL-encoded)
                (music, &more=1: only its start, so the face plays it at once; X-Duration = the whole song, seconds)
  POST /clip/more?id=…&done=0|1  body = the next bytes of that song (event "grow"; done: its voice gets isolated)
                                                    and X-Phonemes ([[phoneme, ms], …] as URL-encoded JSON, optional)
  POST /stop    {} or {"turn": N}                   cuts speech and empties the queue; then ignores clips of turns < N
                ({"keep": "music"}: the current song goes on)
  POST /state   {"mode": "idle|listen|think"}       the face's background mood
  POST /gaze    {"x": -1..1, "y": -1..1} or {}      where to look (a sensor, later)
  POST /theme   {"id": "pixel"}                     changes the face
  POST /take    {"client": "…"}                     this page talks now; the others fall silent (event "take")
  POST /lang    {"lang": "en|fr"}                   the language Eli speaks (event "lang"; ELI_LANG in .env, auto by default)
  GET  /events                                      SSE stream to the page
  GET  /clips/<id>, /stems/<hash>.wav               audio bytes (/clips/<id>?compat=1: converted to AAC;
                                                    /stems: the isolated voice, partial while it is computed)
Role 2 · the brain (brain.py), which only talks to the screen through this protocol:
  POST /brain/listen  body = mic WAV                → transcription → answer → voice
  POST /brain/chat    {"text": "…"}                 → answer → voice
  POST /brain/speak   {"text": "…"}                 → voice (says exactly this text)
  POST /brain/reset   (?all=1: the notebook too)    forgets the conversation
  POST /brain/intro                                 introductions: Eli asks a few questions to get to know you
  POST /brain/meow                                  a meow (cat faces)
  POST /brain/brief                                 the morning brief: date, weather (BRIEF_CITY), a word for you
  POST /brain/hotword  body = 16 kHz mono WAV       always-on listening: is it "Eli, …"? (see hotword.py)
  POST /key  {"groq": "gsk_…"}                     the Groq key from Settings: checked with Groq, kept in the .env
             {"llm_url", "llm_model", "llm_key"}    or a local OpenAI-style LLM (checked on /models); llm_url "" = Groq
             {"model": "…"}                         another model on the same brain (GET /api/models lists them)
  POST /music/setup  {"url","user","password"}      Navidrome access (checked, only a token is kept); /music/forget
  GET  /api/status, /api/voices, /api/memory        state (incl. "lang", "lang_setting"), voices (POST /voice {"id"}), memories
  GET  /api/music                                   {"configured","url","user","server"}
  GET  /api/music/songs?q=…                         the picker: library search (nothing = random songs)
  GET  /music/cover/<id>                            album art, proxied (the Subsonic token stays here)
  POST /music/play  {"id": "…"}                    sing this library song now
  POST /music/ping                                 is the music server answering (and how fast)
  POST /music/prev, /music/next                    the songs sung, back and forth (a random one past the end)
  GET  /api/logs?after=N                            developer mode: recent log lines, secrets stripped
  Songs may carry X-Genre; the server announces their look (event "genre", see genre.py) and their synced lyrics
  from LRCLIB (event "lyrics", see lyrics.py; LYRICS=off in .env to skip).
  Speech clips may carry X-Mood (joie, tristesse… see tags.py): the face acts the emotion.
"""
from __future__ import annotations

import hashlib
import io
import ipaddress
import json
import logging
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brain import Brain, FaceClient  # noqa: E402
import devlog  # noqa: E402
import genre  # noqa: E402
import keys  # noqa: E402
import lyrics  # noqa: E402
from hotword import Hotword, command  # noqa: E402
from navidrome import MusicError, Navidrome  # noqa: E402
import tags  # noqa: E402
from stems import Stems  # noqa: E402
from voice import make_tts  # noqa: E402

log = logging.getLogger("eli")
RING = devlog.Ring()  # the last log lines, for developer mode (GET /api/logs)
logging.getLogger().addHandler(RING)
mimetypes.add_type("audio/wav", ".wav")  # otherwise the brain's clips are stored as .bin

ROOT = Path(__file__).resolve().parent.parent  # the code (read-only inside the Mac app)
DATA = Path(os.environ.get("ELI_DATA") or ROOT)  # what Eli writes: .env, memory, voices, cache, local/
VERSION = os.environ.get("ELI_VERSION") or devlog.version(ROOT)  # the app says it: no git call (it would pop Xcode's installer)
BOOT = uuid.uuid4().hex[:8]  # log lines are numbered from 1 again after a restart
WEB = ROOT / "web"
CACHE = DATA / "cache"
MAX_AUDIO = 150 * 1024 * 1024
MAX_JSON = 64 * 1024
CACHE_BYTES = 400 * 1024 * 1024
KEEP_RECENT = 30 * 60  # s: cache cleanup spares younger files
MODES = {"idle", "listen", "think"}
LANGS = ("fr", "en")
THEME_ID = re.compile(r"^[a-z0-9-]{1,32}$")
CLIP_ID = re.compile(r"^[0-9a-f]{12}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
SONG_ID = re.compile(r"^[\w.-]{1,80}$")  # Subsonic ids (songs, covers): opaque, but never a path
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".aif", ".aiff", ".caf", ".webm", ".mp4"}

DEFAULTS = {
    "HOST": "127.0.0.1",
    "PORT": "5280",
    "GROQ_API_KEY": "",
    "ECHO_URL": "",
    "ECHO_API_KEY": "",
    "STT_PROVIDERS": "groq,echo",
    "ELI_LANG": "auto",  # en, fr, or auto: the page's language (its browser's), which the page can override
    "STT_LANGUAGE": "",  # empty = follows the language
    "GROQ_STT_MODEL": "whisper-large-v3-turbo",
    "LLM_URL": "",  # a local OpenAI-style LLM (mlx_lm.server, Ollama…); empty = Groq
    "LLM_API_KEY": "",
    "BRIEF_CITY": "",  # city for the morning brief's weather (Open-Meteo), empty = no weather
    "ALLOWED_HOSTS": "",  # names served besides IPs and localhost (e.g. eli.tailnet.ts.net behind tailscale serve)
    "NAVIDROME_URL": "", "NAVIDROME_USER": "", "NAVIDROME_PASSWORD": "",  # or the Settings → Music form
    "LLM_MODEL": "openai/gpt-oss-120b",
    "LLM_FALLBACK_MODEL": "openai/gpt-oss-20b",
    "TTS": "piper",
    "SAY_VOICE": "Thomas",
    "SEPARATOR_MODEL": "voices/Kim_Vocal_2.onnx",
    "FACE_URL": "",
    "PERSONA_FILE": str(DATA / "persona.txt"),
    "MEMORY_DIR": str(DATA / "memory"),
}


def load_config(env_file: Path = DATA / ".env") -> dict:
    cfg = dict(DEFAULTS)
    if env_file.is_file():
        for line in env_file.read_text("utf-8").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and not key.startswith("#"):
                cfg[key.strip()] = value.strip().strip("'\"")
    cfg.update({k: v for k, v in os.environ.items() if k in DEFAULTS})
    return cfg


def default_lang(cfg: dict) -> str:
    """ELI_LANG=en|fr, or auto: the system locale until a page says which language it speaks (POST /lang)."""
    if cfg.get("ELI_LANG") in LANGS:
        return cfg["ELI_LANG"]
    return "fr" if (os.environ.get("LC_ALL") or os.environ.get("LANG") or "").lower().startswith("fr") else "en"


_prune_lock = threading.Lock()


FFMPEG = shutil.which("ffmpeg") or next(
    (p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.access(p, os.X_OK)), None
)
FFPROBE = shutil.which("ffprobe") or (str(Path(FFMPEG).with_name("ffprobe")) if FFMPEG else None)
_compat_lock = threading.Lock()


def compat_audio(src: Path) -> Path:
    """AAC copy of a sound the browser can't decode (Apple's ALAC m4a in Chrome, for example)."""
    out = src.with_name(src.stem + ".compat.m4a")
    with _compat_lock:  # ponytail: one global lock, one conversion at a time; per file if it becomes common
        if not out.exists():
            if not FFMPEG:
                raise RuntimeError("ffmpeg not found")
            tmp = out.with_suffix(".part")
            cmd = [FFMPEG, "-v", "error", "-y", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "192k", "-f", "ipod", str(tmp)]
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
            tmp.replace(out)
    return out


def prune(folder: Path, limit: int) -> None:
    """Keeps the cache under `limit` bytes by deleting the oldest files (the disk is nearly full).
    Recent files stay: a song may be waiting for its voice to be isolated, a page may be playing it."""
    with _prune_lock:
        files = sorted(((p.stat(), p) for p in folder.glob("*") if p.is_file()), key=lambda f: f[0].st_mtime)
        total, now = sum(st.st_size for st, _ in files), time.time()
        for st, victim in files:
            if total <= limit or now - st.st_mtime < KEEP_RECENT:
                break
            total -= st.st_size
            victim.unlink(missing_ok=True)


def parse_phonemes(raw: str | None) -> list | None:
    """[[phoneme, duration ms], …] from the brain; anything off is ignored (the mouth will follow the sound)."""
    try:
        data = json.loads(urllib.parse.unquote(raw or ""))
    except ValueError:
        return None
    ok = isinstance(data, list) and len(data) < 2000 and all(
        isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and len(p[0]) <= 4
        and isinstance(p[1], int) and 0 <= p[1] < 10000 for p in data)
    return data if ok else None


class Hub:
    """Broadcasts events to every open page (SSE) and keeps the screen's current state."""

    def __init__(self):
        self.clients: set[queue.Queue] = set()
        self.lock = threading.Lock()
        self.state = {"theme": None, "mode": "idle", "gaze": None}

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)

    def publish(self, event: str, data: dict) -> None:
        msg = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
        with self.lock:
            for q in self.clients:
                try:
                    q.put_nowait(msg)
                except queue.Full:  # frozen page: it will resync when it reconnects
                    pass


class Clips:
    def __init__(self, folder: Path):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.meta: dict[str, tuple[dict, Path]] = {}
        self.lock = threading.Lock()

    def add(self, data: bytes, ctype: str, kind: str, text: str, turn: int, name: str) -> tuple[dict, Path]:
        cid = uuid.uuid4().hex[:12]
        ext = Path(name).suffix.lower() if Path(name).suffix.lower() in AUDIO_EXT else (mimetypes.guess_extension(ctype) or ".bin")
        path = self.folder / f"{cid}{ext}"
        path.write_bytes(data)
        meta = {"id": cid, "kind": kind, "text": text, "turn": turn, "url": f"/clips/{cid}", "name": name}
        with self.lock:
            self.meta[cid] = (dict(meta, type=ctype), path)
        prune(self.folder, CACHE_BYTES)
        return meta, path

    def get(self, cid: str) -> tuple[dict, Path] | None:
        with self.lock:
            found = self.meta.get(cid)
        return found if found and found[1].exists() else None


SEPARATOR_URL = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx"


def fetch_separator(cfg: dict) -> bool:
    """Downloads the default singing model (~65 MB) if it's missing; SEPARATOR_MODEL=off or another model: nothing."""
    model = DATA / DEFAULTS["SEPARATOR_MODEL"]
    if cfg["SEPARATOR_MODEL"] != DEFAULTS["SEPARATOR_MODEL"] or model.exists() or not FFMPEG:
        return False
    log.info("downloading the singing model (~65 MB)…")
    model.parent.mkdir(parents=True, exist_ok=True)
    tmp = model.with_suffix(".part")
    urllib.request.urlretrieve(SEPARATOR_URL, tmp)
    tmp.replace(model)
    return True


def make_stems(cfg: dict, on_ready, on_progress) -> Stems | None:
    """Voice separation, if its model and ffmpeg are there; otherwise he dances without singing."""
    model = Path(cfg["SEPARATOR_MODEL"])
    model = model if model.is_absolute() else DATA / model
    if not (FFMPEG and model.exists()):
        log.warning("singing disabled: %s", "ffmpeg not found" if not FFMPEG else f"model missing ({model.name})")
        return None
    try:
        from mdx import Separator
        return Stems(Separator(model), FFMPEG, CACHE / "stems", on_ready, on_progress)
    except Exception as exc:  # onnxruntime missing, unreadable model…
        log.warning("singing disabled: %s", exc)
        return None


def pcm16k(data: bytes) -> bytes | None:
    """The samples of a 16-bit mono 16 kHz WAV, or None if it isn't one."""
    try:
        with wave.open(io.BytesIO(data)) as wf:
            if (wf.getnchannels(), wf.getsampwidth(), wf.getframerate()) != (1, 2, 16000):
                return None
            return wf.readframes(wf.getnframes())
    except (wave.Error, EOFError):
        return None


class App:
    def __init__(self, cfg: dict, port: int, tts=None, with_stems: bool = True):
        self.cfg, self.port = cfg, port
        self.hub = Hub()
        self.hub.state["lang"] = default_lang(cfg)
        lang = lambda: self.hub.state["lang"]  # noqa: E731
        self.clips = Clips(CACHE / "clips")
        self.tts = tts or make_tts(cfg, DATA, lang())
        self.stems = make_stems(cfg, self._stem_ready, self._stem_progress) if with_stems else None
        if with_stems and not self.stems:
            threading.Thread(target=self._fetch_singer, daemon=True).start()
        self.music = Navidrome(DATA / "local" / "navidrome.json", cfg)
        self.brain = Brain(cfg, self.tts, FaceClient(cfg.get("FACE_URL") or f"http://127.0.0.1:{port}"), self.hub.publish,
                           lambda: self.hub.state["theme"], self.music, lang)
        self.hotword = Hotword(DATA / "voices", lang)
        self.sync_voice()  # the chosen voice of this language may still need downloading

    def _fetch_singer(self) -> None:
        try:
            if fetch_separator(self.cfg):
                self.stems = make_stems(self.cfg, self._stem_ready, self._stem_progress)
                self.hub.publish("info", self.status())  # Settings › Engine: he sings now
        except OSError as exc:
            log.warning("no singing model: %s", exc)

    def _stem_ready(self, clip_id: str, sha: str, error: str | None) -> None:
        if error:
            self.hub.publish("stem", {"id": clip_id, "error": error})
        else:
            self.hub.publish("stem", {"id": clip_id, "url": f"/stems/{sha}.wav"})
            prune(CACHE / "stems", CACHE_BYTES)

    def _stem_progress(self, clip_ids: list[str], sha: str, done: int, total: int) -> None:
        for clip_id in clip_ids:
            self.hub.publish("stem", {"id": clip_id, "url": f"/stems/{sha}.wav", "done": done, "total": total})

    def sync_voice(self) -> None:
        """The voice follows the language; a missing Piper voice downloads (~60 MB) in a thread."""
        tts, lang = self.tts, self.hub.state["lang"]
        if not hasattr(tts, "set_lang"):
            return

        def run() -> None:
            try:
                tts.set_lang(lang, lambda: self.hub.publish("voice", tts.catalog()))
            except Exception as exc:
                log.warning("no %s voice: %s", lang, exc)
            self.hub.publish("voice", tts.catalog())

        threading.Thread(target=run, daemon=True).start()

    def dress(self, clip_id: str, path: Path, name: str, known: str, duration: float | None = None) -> None:
        """The song's genre (event "genre": the page dresses Eli) and synced lyrics (event "lyrics": the karaoke line).
        duration: the whole song's, when only its start has arrived (the file's own would be too short)."""
        look = genre.detect(path, name, known, FFPROBE, self.brain.quick if self.brain.has_llm() else None)
        log.info("genre of %s: %s", name, look or "unknown")
        if look:
            self.hub.publish("genre", {"id": clip_id, "look": look})
        if self.cfg.get("LYRICS", "on") == "off":
            return
        info = genre.tags(path, FFPROBE)
        if duration:
            info["duration"] = duration
        who = lyrics.guess(name, info)
        lines = lyrics.fetch(*who, info.get("duration")) if who else None
        log.info("lyrics of %s: %s", name, f"{len(lines)} lines" if lines else "none")
        if lines:
            self.hub.publish("lyrics", {"id": clip_id, "lines": lines, "artist": who[0], "title": who[1]})
        else:  # the page says so once, and keeps the face where it is
            self.hub.publish("lyrics", {"id": clip_id, "lines": []})

    def status(self) -> dict:
        return {
            "tts": self.tts.name,
            "stt": self.cfg["STT_PROVIDERS"],
            "llm": self.cfg["LLM_MODEL"] if self.brain.has_llm() else None,
            "llm_url": self.cfg.get("LLM_URL", ""),  # an address, not a secret: Settings shows which brain is plugged
            "stems": bool(self.stems),
            "turn": self.brain.turn,
            "version": VERSION,  # a page that (re)connects knows which clips are stale
            "pages": len(self.hub.clients),  # open faces: run.sh opens a tab only if none came back
            "lang_setting": self.cfg.get("ELI_LANG", "auto"),  # ELI_LANG in .env; the page's choice wins over it
            **self.hub.state,  # incl. "lang", the language Eli speaks now
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "Eli/0.1"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # the default log is too chatty (one line per static file)
        pass

    # --- responses ----------------------------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: dict) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _error(self, code: int, message: str) -> None:
        self._json(code, {"ok": False, "error": message})

    # --- safeguards ---------------------------------------------------------------------------
    def _host_ok(self) -> bool:
        """Refuses domain names (DNS rebinding): only IPs, localhost and ALLOWED_HOSTS are served."""
        host = urllib.parse.urlsplit("//" + (self.headers.get("Host") or "")).hostname or ""
        allowed = {h.strip().lower() for h in self.app.cfg.get("ALLOWED_HOSTS", "").split(",") if h.strip()}
        if host == "localhost" or host in allowed:
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

    def _origin_ok(self) -> bool:
        """A page from another site must not be able to make the robot talk (CSRF)."""
        origin = self.headers.get("Origin")
        return origin is None or urllib.parse.urlsplit(origin).netloc == self.headers.get("Host")

    def _body(self, limit: int) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0 or length > limit:
            self._error(413 if length > limit else 400, "body missing or too large")
            return None
        return self.rfile.read(length)

    def _json_body(self) -> dict | None:
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            self._error(415, "JSON expected")
            return None
        raw = self._body(MAX_JSON)
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            self._error(400, "invalid JSON")
            return None
        if not isinstance(data, dict):
            self._error(400, "JSON object expected")
            return None
        return data

    # --- GET ----------------------------------------------------------------------------------
    def do_GET(self) -> None:
        if not self._host_ok():
            return self._error(403, "host refused")
        path = urllib.parse.urlsplit(self.path).path
        if path == "/events":
            return self._events()
        if path == "/api/status":
            return self._json(200, self.app.status())
        if path == "/api/models":  # the picker in Settings > Brain
            try:
                return self._json(200, {"current": self.app.cfg["LLM_MODEL"], "models": self.app.brain.models()})
            except keys.BadKey as exc:
                return self._error(502, str(exc))
        if path == "/api/memory":
            mem = self.app.brain.memory
            return self._json(200, {"notes": mem.notes(), "messages": len(mem.recent())})
        if path == "/api/logs":  # developer mode: the log lines after ?after=N, secrets stripped
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            after = q.get("after", ["0"])[0]
            if q.get("boot", [BOOT])[0] != BOOT:  # the page counted another server's lines: start over
                after = "0"
            return self._json(200, {"lines": RING.after(int(after) if after.isdigit() else 0), "version": VERSION,
                                    "boot": BOOT})
        if path == "/api/music":
            return self._json(200, self.app.music.status())
        if path == "/api/music/songs":  # the picker: ?q=… searches, nothing = a random handful
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0]
            try:
                return self._json(200, {"songs": self.app.music.songs(q[:100])})
            except MusicError as exc:
                return self._error(502, str(exc))
        if path.startswith("/music/cover/"):
            cover = path[13:]
            if not SONG_ID.match(cover) or not self.app.music.auth:
                return self._error(404, "unknown cover")
            try:
                return self._send(200, self.app.music.cover(cover), "image/jpeg")
            except MusicError:
                return self._error(404, "no cover")
        if path == "/api/voices":
            catalog = getattr(self.app.tts, "catalog", None)
            return self._json(200, catalog() if catalog else {"current": None, "busy": None, "voices": []})
        if path.startswith("/clips/"):
            found = self.app.clips.get(path[7:]) if CLIP_ID.match(path[7:]) else None
            if not found:
                return self._error(404, "unknown clip")
            meta, file = found
            if urllib.parse.urlsplit(self.path).query == "compat=1":  # the page couldn't decode it
                try:
                    return self._send(200, compat_audio(file).read_bytes(), "audio/mp4")
                except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                    log.warning("can't convert %s: %s", file.name, exc)
                    return self._error(415, "unreadable format, and the MP3 conversion failed")
            return self._send(200, file.read_bytes(), meta["type"] or "application/octet-stream")
        if path.startswith("/stems/"):
            sha = path[7:].removesuffix(".wav")
            audio = self.app.stems.audio(sha) if self.app.stems and SHA.match(sha) else None
            if audio is None:
                return self._error(404, "unknown isolated voice")
            return self._send(200, audio, "audio/wav")
        return self._static(path)

    def _static(self, path: str) -> None:
        target = (WEB / urllib.parse.unquote(path).lstrip("/")).resolve()
        if target.is_dir():
            target = target / "index.html"
        if WEB.resolve() not in target.parents or not target.is_file():
            return self._error(404, "not found")
        ctype = "text/javascript" if target.suffix in (".js", ".mjs") else (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def _events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.connection.settimeout(60)  # page gone without notice: the write eventually fails
        q = self.app.hub.subscribe()
        try:
            hello = json.dumps(self.app.status(), ensure_ascii=False)
            self.wfile.write(f"event: hello\ndata: {hello}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = b": ping\n\n"
                self.wfile.write(msg)
                self.wfile.flush()
        except OSError:  # the page closed
            pass
        finally:
            self.app.hub.unsubscribe(q)

    # --- POST ---------------------------------------------------------------------------------
    def do_POST(self) -> None:
        if not (self._host_ok() and self._origin_ok()):
            return self._error(403, "origin refused")
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        route = {
            "/clip": self._post_clip,
            "/clip/more": self._post_clip_more,
            "/stop": self._post_stop,
            "/state": self._post_state,
            "/gaze": self._post_gaze,
            "/theme": self._post_theme,
            "/take": self._post_take,
            "/lang": self._post_lang,
            "/voice": self._post_voice,
            "/brain/listen": self._post_listen,
            "/brain/chat": self._post_chat,
            "/brain/speak": self._post_speak,
            "/brain/reset": self._post_reset,
            "/brain/intro": self._post_intro,
            "/brain/meow": self._post_meow,
            "/brain/brief": self._post_brief,
            "/brain/hotword": self._post_hotword,
            "/key": self._post_key,
            "/music/setup": self._post_music_setup,
            "/music/forget": self._post_music_forget,
            "/music/ping": self._post_music_ping,
            "/music/play": self._post_music_play,
            "/music/next": lambda _q: self._post_music_step(1),
            "/music/prev": lambda _q: self._post_music_step(-1),
        }.get(url.path)
        if route is None:
            return self._error(404, "unknown route")
        route(query)

    def _audio_body(self) -> bytes | None:
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        # "Simple" types (text/plain, forms) are those a third-party site can send without permission.
        if ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
            self._error(415, "send the raw audio file (audio/*)")
            return None
        return self._body(MAX_AUDIO)

    def _post_clip(self, query: dict) -> None:
        kind = query.get("kind", "speech")
        if kind not in ("speech", "music"):
            return self._error(400, "kind must be speech or music")
        data = self._audio_body()
        if data is None:
            return
        try:
            turn = int(query.get("turn", "0"))
        except ValueError:
            turn = 0
        text = urllib.parse.unquote(self.headers.get("X-Text") or "")[:500]
        name = Path(query.get("name", "clip")).name[:120]
        ctype = (self.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
        meta, path = self.app.clips.add(data, ctype, kind, text, turn, name)
        phonemes = parse_phonemes(self.headers.get("X-Phonemes"))
        if phonemes:
            meta["phonemes"] = phonemes
        mood = urllib.parse.unquote(self.headers.get("X-Mood") or "")
        if mood in tags.MOODS:
            meta["mood"] = mood
        if kind == "music":
            known = urllib.parse.unquote(self.headers.get("X-Genre") or "")
            try:
                duration = min(max(float(self.headers.get("X-Duration") or 0), 0), 24 * 3600) or None
            except ValueError:
                duration = None
            threading.Thread(target=self.app.dress, args=(meta["id"], path, name, known, duration), daemon=True).start()
            meta["stem"] = "off"
            if query.get("more") == "1":  # the rest follows (/clip/more): its voice is isolated once it's all here
                meta.update(growing=True, duration=duration, stem="pending" if self.app.stems else "off")
            elif self.app.stems:
                meta["stem"] = "pending"
                sha = hashlib.sha256(data).hexdigest()
                self.app.hub.publish("clip", meta)
                if self.app.stems.request(path, sha, meta["id"]):
                    meta["stem"] = "ready"
                return self._json(200, {"ok": True, **meta})
        self.app.hub.publish("clip", meta)
        self._json(200, {"ok": True, **meta})

    def _post_clip_more(self, query: dict) -> None:
        """The next bytes of a song sent with more=1; the pages reload it, and play on where the start ended."""
        cid = query.get("id", "")
        found = self.app.clips.get(cid) if CLIP_ID.match(cid) else None
        if not found or found[0]["kind"] != "music":
            return self._error(404, "unknown clip")
        data = self._audio_body()
        if data is None:
            return
        path, done = found[1], query.get("done") == "1"
        if path.stat().st_size + len(data) > MAX_AUDIO:
            return self._error(413, "song too big")
        with path.open("ab") as f:
            f.write(data)
        size = path.stat().st_size
        self.app.hub.publish("grow", {"id": cid, "size": size, "done": done})
        if done and self.app.stems:
            self.app.stems.request(path, hashlib.sha256(path.read_bytes()).hexdigest(), cid)
        self._json(200, {"ok": True, "size": size})

    def _post_stop(self, _query: dict) -> None:
        turn, keep = None, None
        if self.headers.get("Content-Length", "0") != "0":
            data = self._json_body()
            if data is None:
                return
            turn, keep = data.get("turn"), "music" if data.get("keep") == "music" else None
            if turn is not None and (not isinstance(turn, int) or isinstance(turn, bool)):
                return self._error(400, 'expected {} or {"turn": N}')
        if turn is None:  # stop from a human: the brain also drops what it was preparing (but Esc keeps a song coming)
            self.app.brain.cancel(keep)
            turn = self.app.brain.turn
        self.app.hub.publish("stop", {"turn": turn, "keep": keep})
        self._json(200, {"ok": True})

    def _post_state(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        if data.get("mode") not in MODES:
            return self._error(400, f"mode among {sorted(MODES)}")
        self.app.hub.state["mode"] = data["mode"]
        self.app.hub.publish("state", {"mode": data["mode"]})
        self._json(200, {"ok": True})

    def _post_gaze(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        gaze = None
        if data:
            try:
                gaze = {k: max(-1.0, min(1.0, float(data[k]))) for k in ("x", "y")}
            except (KeyError, TypeError, ValueError):
                return self._error(400, 'expected {"x": -1..1, "y": -1..1} or {}')
        self.app.hub.state["gaze"] = gaze
        self.app.hub.publish("gaze", {"gaze": gaze})
        self._json(200, {"ok": True})

    def _post_theme(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        theme = data.get("id")
        if not isinstance(theme, str) or not THEME_ID.match(theme):
            return self._error(400, "invalid theme id")
        self.app.hub.state["theme"] = theme
        self.app.hub.publish("theme", {"id": theme, "from": data.get("from")})
        self._json(200, {"ok": True})

    def _post_take(self, _query: dict) -> None:
        """A page takes the floor: the others (tabs, apps, other devices) fall silent, so Eli has one voice."""
        data = self._json_body()
        if data is None:
            return
        self.app.hub.publish("take", {"client": str(data.get("client", ""))[:20]})
        self._json(200, {"ok": True})

    def _post_lang(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        lang = data.get("lang")
        if lang not in LANGS:
            return self._error(400, 'expected {"lang": "en"} or {"lang": "fr"}')
        if lang != self.app.hub.state["lang"]:  # ponytail: one language for all pages, the last one to say wins
            self.app.hub.state["lang"] = lang
            self.app.hub.publish("lang", {"lang": lang})
            self.app.sync_voice()
        self._json(200, {"ok": True})

    def _post_voice(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        voice, tts = data.get("id"), self.app.tts
        if isinstance(data.get("cat"), bool) and hasattr(tts, "set_cat"):  # {"cat": true}: cat voice filter
            tts.set_cat(data["cat"])
            self.app.hub.publish("voice", tts.catalog())
            if self.app.brain.cat():  # on another face the voice doesn't change: nothing to hear
                self.app.brain.start("speak", self.app.brain.line("cat_on" if data["cat"] else "cat_off"))
            return self._json(200, {"ok": True})
        if not hasattr(tts, "choose") or not isinstance(voice, str) or voice not in {v["id"] for v in tts.catalog()["voices"]}:
            return self._error(400, "unknown voice")

        def switch() -> None:  # a Piper voice not there yet downloads (~60 MB): outside the request
            try:
                tts.choose(voice)
            except Exception as exc:
                log.warning("voice %s failed: %s", voice, exc)
                return self.app.hub.publish("voice", {**tts.catalog(), "error": str(exc)[:200]})
            self.app.hub.publish("voice", tts.catalog())
            self.app.brain.start("speak", self.app.brain.line("new_voice"))

        self.app.hub.publish("voice", {**tts.catalog(), "busy": voice})
        threading.Thread(target=switch, daemon=True).start()
        self._json(202, {"ok": True})

    def _post_listen(self, _query: dict) -> None:
        data = self._audio_body()
        if data is not None:
            self._json(202, {"ok": True, "turn": self.app.brain.start("listen", data)})

    def _text_turn(self, kind: str) -> None:
        data = self._json_body()
        if data is None:
            return
        text = data.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            return self._error(400, "text between 1 and 2000 characters")
        self._json(202, {"ok": True, "turn": self.app.brain.start(kind, text.strip())})

    def _post_chat(self, _query: dict) -> None:
        self._text_turn("chat")

    def _post_speak(self, _query: dict) -> None:
        self._text_turn("speak")

    def _post_intro(self, _query: dict) -> None:
        self._json(202, {"ok": True, "turn": self.app.brain.intro()})

    def _post_brief(self, _query: dict) -> None:
        self._json(202, {"ok": True, "turn": self.app.brain.brief()})

    def _post_meow(self, _query: dict) -> None:
        self._json(202, {"ok": True, "turn": self.app.brain.start("meow", None)})

    def _post_hotword(self, _query: dict) -> None:
        """A bit of speech heard while always listening: is someone talking to Eli?
        Answers: {"wake": false}; {"wake": true, "listen": true} (just his name: he listens for the rest);
        {"wake": true, "turn": N} ("Eli, …": he answers)."""
        data = self._audio_body()
        if data is None:
            return
        pcm = pcm16k(data)
        if pcm is None:
            return self._error(400, "16-bit mono 16 kHz WAV expected")
        app = self.app
        try:
            if not app.hotword.maybe(pcm):
                return self._json(200, {"wake": False})
            if len(pcm) < 2 * 16000:  # under a second: just his name, no need to transcribe
                return self._json(200, {"wake": True, "listen": True})
            text, provider = app.brain.transcribe(data)
        except Exception as exc:  # model missing, Vosk not installed, ears down
            log.warning("wake word failed: %s", exc)
            return self._error(503, f"listening for \"Eli\" unavailable: {exc}")
        cmd = command(text)
        if cmd is None:
            return self._json(200, {"wake": False})
        if not cmd:
            return self._json(200, {"wake": True, "listen": True})
        app.hub.publish("brain", {"stage": "heard", "text": text, "provider": provider})
        self._json(200, {"wake": True, "turn": app.brain.start("chat", cmd)})

    def _post_music_setup(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        url, user, password = (data.get(k) for k in ("url", "user", "password"))
        if not all(isinstance(v, str) for v in (url, user, password)):
            return self._error(400, "url, user and password expected")
        try:
            status = self.app.music.setup(url, user, password)
        except MusicError as exc:
            return self._error(400, str(exc))
        self.app.hub.publish("music", status)
        self._json(200, {"ok": True, **status})

    def _post_key(self, _query: dict) -> None:
        """{"groq": "gsk_…"}, or {"llm_url", "llm_model"?, "llm_key"?} for a local OpenAI-style LLM ("llm_url": "" = Groq)."""
        data = self._json_body()
        if data is None:
            return
        fields = {k: data.get(k) for k in ("groq", "llm_url", "llm_model", "llm_key", "model") if k in data}
        if not fields or not all(isinstance(v, str) for v in fields.values()):
            return self._error(400, "groq or llm_url expected")
        fields = {k: v.strip() for k, v in fields.items()}
        try:
            if "model" in fields:  # the picker: another model on the same brain
                if not fields["model"] or not keys.ENV_VALUE.fullmatch(fields["model"]):
                    raise keys.BadKey("invalid model")
                updates = {"LLM_MODEL": fields["model"]}
            elif "groq" in fields:
                keys.check_groq(fields["groq"])
                updates = {"GROQ_API_KEY": fields["groq"]}
            elif not fields["llm_url"]:  # back to Groq
                updates = {"LLM_URL": "", "LLM_API_KEY": "", "LLM_MODEL": DEFAULTS["LLM_MODEL"],
                           "LLM_FALLBACK_MODEL": DEFAULTS["LLM_FALLBACK_MODEL"]}
            else:
                models = keys.check_llm(fields["llm_url"], fields.get("llm_key", ""))
                model = fields.get("llm_model") or (models[0] if models else "")
                if not model or not keys.ENV_VALUE.fullmatch(model):
                    raise keys.BadKey("which model? the server lists none")
                updates = {"LLM_URL": fields["llm_url"], "LLM_API_KEY": fields.get("llm_key", ""), "LLM_MODEL": model,
                           "LLM_FALLBACK_MODEL": ""}  # Groq's fallback name means nothing to a local server
        except keys.BadKey as exc:
            return self._error(400, str(exc))
        try:
            for name, value in updates.items():
                keys.save(DATA / ".env", name, value)
        except OSError as exc:  # Docker mounts the .env read-only: it's edited on the host there
            log.warning("brain settings not saved: %s", exc)
            return self._error(500, "the .env can't be written here: set it in the server's .env")
        self.app.cfg.update(updates)  # the brain shares this dict: he thinks with it from the next sentence on
        log.info("brain settings saved: %s", ", ".join(updates))
        self.app.hub.publish("info", self.app.status())
        self._json(200, {"ok": True, **self.app.status()})

    def _post_music_forget(self, _query: dict) -> None:
        self.app.music.forget()
        self.app.hub.publish("music", self.app.music.status())
        self._json(200, self.app.music.status())

    def _post_music_ping(self, _query: dict) -> None:
        try:
            self._json(200, self.app.music.ping())
        except MusicError as exc:
            self._error(502, str(exc))

    def _post_music_play(self, _query: dict) -> None:
        """The picker: sing this library song now (the page has already stopped what was playing)."""
        data = self._json_body()
        if data is None:
            return
        song_id = data.get("id")
        if not isinstance(song_id, str) or not SONG_ID.match(song_id):
            return self._error(400, "song id expected")
        brain = self.app.brain

        def play() -> None:
            try:
                song = self.app.music.song(song_id)
                brain.publish("brain", {"stage": "fetch", "text": f"{song['artist']} – {song['title']}".strip(" –")})
                brain.sing(song)
            except (MusicError, OSError) as exc:
                log.warning("picker: can't play %s: %s", song_id, exc)
                brain.publish("brain", {"stage": "error", "error": str(exc)})
        threading.Thread(target=play, daemon=True).start()
        self._json(200, {"ok": True})

    def _post_music_step(self, delta: int) -> None:
        """The mini player's previous / next."""
        brain = self.app.brain

        def play() -> None:
            try:
                song, new = brain.step(delta)
                if not song:
                    return brain.publish("brain", {"stage": "error", "error": "no song"})
                brain.publish("brain", {"stage": "fetch", "text": f"{song['artist']} – {song['title']}".strip(" –")})
                brain.sing(song, remember=new)
            except (MusicError, OSError) as exc:
                log.warning("music step %+d: %s", delta, exc)
                brain.publish("brain", {"stage": "error", "error": str(exc)})
        threading.Thread(target=play, daemon=True).start()
        self._json(200, {"ok": True})

    def _post_reset(self, query: dict) -> None:
        self.app.brain.reset(everything=query.get("all") == "1")
        self._json(200, {"ok": True})


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return  # the page hung up before the answer (song skipped, tab closed): nothing went wrong here
        super().handle_error(request, client_address)


def make_server(cfg: dict, port: int | None = None, **app_kwargs) -> ThreadingHTTPServer:
    server = Server((cfg["HOST"], int(cfg["PORT"]) if port is None else port), Handler)
    server.daemon_threads = True
    server.app = App(cfg, server.server_address[1], **app_kwargs)  # type: ignore[attr-defined]
    return server


def main() -> None:
    # force: RING is already on the root logger, so a plain basicConfig would do nothing (level stuck at WARNING,
    # no INFO line in the terminal nor in the page's log drawer)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s · %(message)s", datefmt="%H:%M:%S",
                        handlers=[logging.StreamHandler(), RING], force=True)
    cfg = load_config()
    server = make_server(cfg)
    app: App = server.app  # type: ignore[attr-defined]
    host, port = server.server_address[:2]
    log.info("voice: %s · transcription: %s · LLM: %s · singing: %s · language: %s",
             app.tts.name, cfg["STT_PROVIDERS"], app.status()["llm"] or "no Groq key", "MDX" if app.stems else "no",
             app.hub.state["lang"])
    log.info("Eli listening on http://%s:%s", "127.0.0.1" if host == "0.0.0.0" else host, port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        time.sleep(0.1)


if __name__ == "__main__":
    main()

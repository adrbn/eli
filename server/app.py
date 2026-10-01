"""Eli — serveur local du simulateur de visage.

Rôle 1 · l'écran. Même protocole que l'ESP32 plus tard ; la page web n'en est qu'un affichage :
  POST /clip?kind=speech|music&turn=N&name=f.mp3   corps = fichier audio, en-tête X-Text (texte dit, encodé URL)
                                                    et X-Phonemes ([[phonème, ms], …] en JSON encodé URL, facultatif)
  POST /stop    {} ou {"turn": N}                   coupe la parole et vide la file ; ignore ensuite les clips des tours < N
                ({"keep": "music"} : le morceau en cours continue)
  POST /state   {"mode": "idle|listen|think"}       humeur de fond du visage
  POST /gaze    {"x": -1..1, "y": -1..1} ou {}      cible du regard (un capteur, plus tard)
  POST /theme   {"id": "pixel"}                     change de visage
  GET  /events                                      flux SSE vers la page
  GET  /clips/<id>, /stems/<empreinte>.wav          octets audio (/clips/<id>?compat=1 : converti en MP3 ;
                                                    /stems : la voix isolée, partielle tant qu'elle se calcule)
Rôle 2 · le cerveau (brain.py), qui ne parle à l'écran que par ce protocole :
  POST /brain/listen  corps = WAV du micro          → transcription → réponse → voix
  POST /brain/chat    {"text": "…"}                 → réponse → voix
  POST /brain/speak   {"text": "…"}                 → voix (dit exactement ce texte)
  POST /brain/reset   (?all=1 : le carnet aussi)    oublie la conversation
  POST /brain/intro                                 les présentations : Eli pose quelques questions pour te connaître
  POST /brain/meow                                  un miaou (visages de chat)
  GET  /api/status, /api/voices, /api/memory        état, voix au choix (POST /voice {"id"}), souvenirs
"""
from __future__ import annotations

import hashlib
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
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brain import Brain, FaceClient  # noqa: E402
from stems import Stems  # noqa: E402
from voice import make_tts  # noqa: E402

log = logging.getLogger("eli")
mimetypes.add_type("audio/wav", ".wav")  # sinon les clips du cerveau sont rangés en .bin

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
MAX_AUDIO = 150 * 1024 * 1024
MAX_JSON = 64 * 1024
CACHE_BYTES = 400 * 1024 * 1024
KEEP_RECENT = 30 * 60  # s : le ménage du cache épargne les fichiers plus jeunes
MODES = {"idle", "listen", "think"}
THEME_ID = re.compile(r"^[a-z0-9-]{1,32}$")
CLIP_ID = re.compile(r"^[0-9a-f]{12}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".aif", ".aiff", ".caf", ".webm", ".mp4"}

DEFAULTS = {
    "HOST": "127.0.0.1",
    "PORT": "5280",
    "GROQ_API_KEY": "",
    "ECHO_URL": "",
    "ECHO_API_KEY": "",
    "STT_PROVIDERS": "groq,echo",
    "STT_LANGUAGE": "fr",
    "GROQ_STT_MODEL": "whisper-large-v3-turbo",
    "LLM_MODEL": "openai/gpt-oss-120b",
    "LLM_FALLBACK_MODEL": "openai/gpt-oss-20b",
    "TTS": "piper",
    "SAY_VOICE": "Thomas",
    "SEPARATOR_MODEL": "voices/Kim_Vocal_2.onnx",
    "FACE_URL": "",
    "PERSONA_FILE": str(ROOT / "persona.txt"),
    "MEMORY_DIR": str(ROOT / "memory"),
}


def load_config(env_file: Path = ROOT / ".env") -> dict:
    cfg = dict(DEFAULTS)
    if env_file.is_file():
        for line in env_file.read_text("utf-8").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and not key.startswith("#"):
                cfg[key.strip()] = value.strip().strip("'\"")
    cfg.update({k: v for k, v in os.environ.items() if k in DEFAULTS})
    return cfg


_prune_lock = threading.Lock()


FFMPEG = shutil.which("ffmpeg") or next(
    (p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.access(p, os.X_OK)), None
)
_compat_lock = threading.Lock()


def compat_mp3(src: Path) -> Path:
    """Copie MP3 d'un son que le navigateur ne sait pas décoder (l'ALAC des m4a d'Apple, par exemple)."""
    out = src.with_name(src.stem + ".compat.mp3")
    with _compat_lock:  # ponytail: un verrou global, une conversion à la fois ; par fichier si ça devient courant
        if not out.exists():
            if not FFMPEG:
                raise RuntimeError("ffmpeg introuvable")
            tmp = out.with_suffix(".part")
            cmd = [FFMPEG, "-v", "error", "-y", "-i", str(src), "-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", str(tmp)]
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
            tmp.replace(out)
    return out


def prune(folder: Path, limit: int) -> None:
    """Garde le cache sous `limit` octets en supprimant les plus vieux fichiers (le disque est presque plein).
    Les fichiers récents restent : un morceau peut attendre que sa voix soit isolée, une page peut être en train de le lire."""
    with _prune_lock:
        files = sorted(((p.stat(), p) for p in folder.glob("*") if p.is_file()), key=lambda f: f[0].st_mtime)
        total, now = sum(st.st_size for st, _ in files), time.time()
        for st, victim in files:
            if total <= limit or now - st.st_mtime < KEEP_RECENT:
                break
            total -= st.st_size
            victim.unlink(missing_ok=True)


def parse_phonemes(raw: str | None) -> list | None:
    """[[phonème, durée ms], …] venu du cerveau ; tout ce qui ne colle pas est ignoré (la bouche suivra le son)."""
    try:
        data = json.loads(urllib.parse.unquote(raw or ""))
    except ValueError:
        return None
    ok = isinstance(data, list) and len(data) < 2000 and all(
        isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and len(p[0]) <= 4
        and isinstance(p[1], int) and 0 <= p[1] < 10000 for p in data)
    return data if ok else None


class Hub:
    """Diffuse les événements à toutes les pages ouvertes (SSE) et garde l'état courant de l'écran."""

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
                except queue.Full:  # page figée : elle se resynchronisera en se reconnectant
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


def make_stems(cfg: dict, on_ready, on_progress) -> Stems | None:
    """La séparation de voix, si son modèle et ffmpeg sont là ; sinon il danse sans chanter."""
    model = Path(cfg["SEPARATOR_MODEL"])
    model = model if model.is_absolute() else ROOT / model
    if not (FFMPEG and model.exists()):
        log.warning("chant désactivé : %s", "ffmpeg introuvable" if not FFMPEG else f"modèle absent ({model.name})")
        return None
    try:
        from mdx import Separator
        return Stems(Separator(model), FFMPEG, CACHE / "stems", on_ready, on_progress)
    except Exception as exc:  # onnxruntime absent, modèle illisible…
        log.warning("chant désactivé : %s", exc)
        return None


class App:
    def __init__(self, cfg: dict, port: int, tts=None, with_stems: bool = True):
        self.cfg, self.port = cfg, port
        self.hub = Hub()
        self.clips = Clips(CACHE / "clips")
        self.tts = tts or make_tts(cfg, ROOT)
        self.stems = make_stems(cfg, self._stem_ready, self._stem_progress) if with_stems else None
        self.brain = Brain(cfg, self.tts, FaceClient(cfg.get("FACE_URL") or f"http://127.0.0.1:{port}"), self.hub.publish,
                           lambda: self.hub.state["theme"])

    def _stem_ready(self, clip_id: str, sha: str, error: str | None) -> None:
        if error:
            self.hub.publish("stem", {"id": clip_id, "error": error})
        else:
            self.hub.publish("stem", {"id": clip_id, "url": f"/stems/{sha}.wav"})
            prune(CACHE / "stems", CACHE_BYTES)

    def _stem_progress(self, clip_ids: list[str], sha: str, done: int, total: int) -> None:
        for clip_id in clip_ids:
            self.hub.publish("stem", {"id": clip_id, "url": f"/stems/{sha}.wav", "done": done, "total": total})

    def status(self) -> dict:
        return {
            "tts": self.tts.name,
            "stt": self.cfg["STT_PROVIDERS"],
            "llm": self.cfg["LLM_MODEL"] if self.cfg.get("GROQ_API_KEY") else None,
            "stems": bool(self.stems),
            "turn": self.brain.turn,  # une page qui (re)vient sait quels clips sont périmés
            **self.hub.state,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "Eli/0.1"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # le journal par défaut est trop bavard (une ligne par fichier statique)
        pass

    # --- réponses -----------------------------------------------------------------------------
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

    # --- garde-fous ---------------------------------------------------------------------------
    def _host_ok(self) -> bool:
        """Refuse les noms de domaine (DNS rebinding) : seules les adresses IP et localhost sont servies."""
        host = urllib.parse.urlsplit("//" + (self.headers.get("Host") or "")).hostname or ""
        if host == "localhost":
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

    def _origin_ok(self) -> bool:
        """Une page d'un autre site ne doit pas pouvoir faire parler le robot (CSRF)."""
        origin = self.headers.get("Origin")
        return origin is None or urllib.parse.urlsplit(origin).netloc == self.headers.get("Host")

    def _body(self, limit: int) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length <= 0 or length > limit:
            self._error(413 if length > limit else 400, "corps absent ou trop gros")
            return None
        return self.rfile.read(length)

    def _json_body(self) -> dict | None:
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            self._error(415, "JSON attendu")
            return None
        raw = self._body(MAX_JSON)
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            self._error(400, "JSON invalide")
            return None
        if not isinstance(data, dict):
            self._error(400, "objet JSON attendu")
            return None
        return data

    # --- GET ----------------------------------------------------------------------------------
    def do_GET(self) -> None:
        if not self._host_ok():
            return self._error(403, "hôte refusé")
        path = urllib.parse.urlsplit(self.path).path
        if path == "/events":
            return self._events()
        if path == "/api/status":
            return self._json(200, self.app.status())
        if path == "/api/memory":
            mem = self.app.brain.memory
            return self._json(200, {"notes": mem.notes(), "messages": len(mem.recent())})
        if path == "/api/voices":
            catalog = getattr(self.app.tts, "catalog", None)
            return self._json(200, catalog() if catalog else {"current": None, "busy": None, "voices": []})
        if path.startswith("/clips/"):
            found = self.app.clips.get(path[7:]) if CLIP_ID.match(path[7:]) else None
            if not found:
                return self._error(404, "clip inconnu")
            meta, file = found
            if urllib.parse.urlsplit(self.path).query == "compat=1":  # la page n'a pas su le décoder
                try:
                    return self._send(200, compat_mp3(file).read_bytes(), "audio/mpeg")
                except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                    log.warning("conversion de %s impossible : %s", file.name, exc)
                    return self._error(415, "format illisible, et la conversion en MP3 a échoué")
            return self._send(200, file.read_bytes(), meta["type"] or "application/octet-stream")
        if path.startswith("/stems/"):
            sha = path[7:].removesuffix(".wav")
            audio = self.app.stems.audio(sha) if self.app.stems and SHA.match(sha) else None
            if audio is None:
                return self._error(404, "voix isolée inconnue")
            return self._send(200, audio, "audio/wav")
        return self._static(path)

    def _static(self, path: str) -> None:
        target = (WEB / urllib.parse.unquote(path).lstrip("/")).resolve()
        if target.is_dir():
            target = target / "index.html"
        if WEB.resolve() not in target.parents or not target.is_file():
            return self._error(404, "introuvable")
        ctype = "text/javascript" if target.suffix in (".js", ".mjs") else (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def _events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.connection.settimeout(60)  # page disparue sans prévenir : l'écriture finit par lâcher
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
        except OSError:  # la page s'est fermée
            pass
        finally:
            self.app.hub.unsubscribe(q)

    # --- POST ---------------------------------------------------------------------------------
    def do_POST(self) -> None:
        if not (self._host_ok() and self._origin_ok()):
            return self._error(403, "origine refusée")
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        route = {
            "/clip": self._post_clip,
            "/stop": self._post_stop,
            "/state": self._post_state,
            "/gaze": self._post_gaze,
            "/theme": self._post_theme,
            "/voice": self._post_voice,
            "/brain/listen": self._post_listen,
            "/brain/chat": self._post_chat,
            "/brain/speak": self._post_speak,
            "/brain/reset": self._post_reset,
            "/brain/intro": self._post_intro,
            "/brain/meow": self._post_meow,
        }.get(url.path)
        if route is None:
            return self._error(404, "route inconnue")
        route(query)

    def _audio_body(self) -> bytes | None:
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        # Les types « simples » (text/plain, formulaires) sont ceux qu'un site tiers peut envoyer sans permission.
        if ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
            self._error(415, "envoie le fichier audio brut (audio/*)")
            return None
        return self._body(MAX_AUDIO)

    def _post_clip(self, query: dict) -> None:
        kind = query.get("kind", "speech")
        if kind not in ("speech", "music"):
            return self._error(400, "kind doit valoir speech ou music")
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
        if kind == "music":
            meta["stem"] = "off"
            if self.app.stems:
                meta["stem"] = "pending"
                sha = hashlib.sha256(data).hexdigest()
                self.app.hub.publish("clip", meta)
                if self.app.stems.request(path, sha, meta["id"]):
                    meta["stem"] = "ready"
                return self._json(200, {"ok": True, **meta})
        self.app.hub.publish("clip", meta)
        self._json(200, {"ok": True, **meta})

    def _post_stop(self, _query: dict) -> None:
        turn, keep = None, None
        if self.headers.get("Content-Length", "0") != "0":
            data = self._json_body()
            if data is None:
                return
            turn, keep = data.get("turn"), "music" if data.get("keep") == "music" else None
            if turn is not None and (not isinstance(turn, int) or isinstance(turn, bool)):
                return self._error(400, 'attendu {} ou {"turn": N}')
        if turn is None:  # stop venu d'un humain : le cerveau abandonne aussi ce qu'il préparait
            self.app.brain.cancel()
            turn = self.app.brain.turn
        self.app.hub.publish("stop", {"turn": turn, "keep": keep})
        self._json(200, {"ok": True})

    def _post_state(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        if data.get("mode") not in MODES:
            return self._error(400, f"mode parmi {sorted(MODES)}")
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
                return self._error(400, 'attendu {"x": -1..1, "y": -1..1} ou {}')
        self.app.hub.state["gaze"] = gaze
        self.app.hub.publish("gaze", {"gaze": gaze})
        self._json(200, {"ok": True})

    def _post_theme(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        theme = data.get("id")
        if not isinstance(theme, str) or not THEME_ID.match(theme):
            return self._error(400, "id de thème invalide")
        self.app.hub.state["theme"] = theme
        self.app.hub.publish("theme", {"id": theme, "from": data.get("from")})
        self._json(200, {"ok": True})

    def _post_voice(self, _query: dict) -> None:
        data = self._json_body()
        if data is None:
            return
        voice, tts = data.get("id"), self.app.tts
        if isinstance(data.get("cat"), bool) and hasattr(tts, "set_cat"):  # {"cat": true} : filtre voix de chat
            tts.set_cat(data["cat"])
            self.app.hub.publish("voice", tts.catalog())
            if self.app.brain.cat():  # sur un autre visage, la voix ne change pas : rien à faire entendre
                self.app.brain.start("speak", "Miaou ! Voilà ma voix de chat." if data["cat"] else "Je reprends ma voix normale.")
            return self._json(200, {"ok": True})
        if not hasattr(tts, "choose") or not isinstance(voice, str) or voice not in {v["id"] for v in tts.catalog()["voices"]}:
            return self._error(400, "voix inconnue")

        def switch() -> None:  # une voix Piper pas encore là se télécharge (~60 Mo) : hors de la requête
            try:
                tts.choose(voice)
            except Exception as exc:
                log.warning("voix %s impossible : %s", voice, exc)
                return self.app.hub.publish("voice", {**tts.catalog(), "error": str(exc)[:200]})
            self.app.hub.publish("voice", tts.catalog())
            self.app.brain.start("speak", "Voilà ma nouvelle voix. Elle te plaît ?")

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
            return self._error(400, "texte entre 1 et 2000 caractères")
        self._json(202, {"ok": True, "turn": self.app.brain.start(kind, text.strip())})

    def _post_chat(self, _query: dict) -> None:
        self._text_turn("chat")

    def _post_speak(self, _query: dict) -> None:
        self._text_turn("speak")

    def _post_intro(self, _query: dict) -> None:
        self._json(202, {"ok": True, "turn": self.app.brain.intro()})

    def _post_meow(self, _query: dict) -> None:
        self._json(202, {"ok": True, "turn": self.app.brain.start("meow", None)})

    def _post_reset(self, query: dict) -> None:
        self.app.brain.reset(everything=query.get("all") == "1")
        self._json(200, {"ok": True})


def make_server(cfg: dict, port: int | None = None, **app_kwargs) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((cfg["HOST"], int(cfg["PORT"]) if port is None else port), Handler)
    server.daemon_threads = True
    server.app = App(cfg, server.server_address[1], **app_kwargs)  # type: ignore[attr-defined]
    return server


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s · %(message)s", datefmt="%H:%M:%S")
    cfg = load_config()
    server = make_server(cfg)
    app: App = server.app  # type: ignore[attr-defined]
    host, port = server.server_address[:2]
    log.info("voix : %s · transcription : %s · LLM : %s · chant : %s",
             app.tts.name, cfg["STT_PROVIDERS"], app.status()["llm"] or "pas de clé Groq", "MDX" if app.stems else "non")
    log.info("Eli écoute sur http://%s:%s", "127.0.0.1" if host == "0.0.0.0" else host, port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        time.sleep(0.1)


if __name__ == "__main__":
    main()

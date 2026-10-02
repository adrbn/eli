"""Server checks: `uv run python -m unittest discover server`."""
from __future__ import annotations

import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
import os
import subprocess
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path

from app import FFMPEG, KEEP_RECENT, load_config, make_server, prune
from brain import Brain, SentenceSplitter, clean_for_tts, multipart
from navidrome import Navidrome


def tiny_wav(seconds: float = 0.2) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buf.getvalue()


class FakeTTS:
    name = "fake voice"

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, list]:
        return tiny_wav(), [["b", 40], ["ɔ", 80]]


class VoicesTest(unittest.TestCase):
    def test_lists_piper_and_mac_voices_and_falls_back_without_model(self):
        from voice import Voices
        with tempfile.TemporaryDirectory() as tmp:
            voices = Voices(Path(tmp), "Thomas")  # model missing: say, no download at startup
            self.assertTrue(voices.current.startswith("say:"))  # Thomas, or the first French voice of this Mac
            ids = [v["id"] for v in voices.catalog()["voices"]]
            self.assertIn("pierre", ids)
            self.assertNotIn("kristin", ids)  # only this language's voices
            with self.assertRaises(ValueError):
                voices.choose("unknown")
            voices.set_cat(True)
            self.assertTrue(Voices(Path(tmp), "Thomas").catalog()["cat"])  # the cat filter is remembered
            english = Voices(Path(tmp), "Thomas", "en")
            self.assertTrue(english.current.startswith("say:") and english.wanted("en") == "kristin")
            self.assertIn("kristin", [v["id"] for v in english.catalog()["voices"]])


class TextTest(unittest.TestCase):
    def test_splits_streamed_sentences(self):
        s = SentenceSplitter()
        out = []
        for delta in ["Bon", "jour Sam. Ça", " va ? M. Dupont", " a 3.5 ans! Et", " voilà"]:
            out += s.feed(delta)
        self.assertEqual(out, ["Bonjour Sam.", "Ça va ?", "M. Dupont a 3.5 ans!"])
        self.assertEqual(s.flush(), ["Et voilà"])

    def test_cuts_endless_sentence_at_comma(self):
        s = SentenceSplitter(soft=60)
        out = s.feed("Une phrase très longue qui continue encore et encore, puis repart sans jamais finir vraiment")
        self.assertEqual(out, ["Une phrase très longue qui continue encore et encore,"])

    def test_never_cuts_inside_a_tag(self):  # « [musique: genre] » coupé au « : » faisait dire « genre] »
        s = SentenceSplitter(soft=80)
        out = s.feed("Respire, imagine une vague calme qui t'emporte doucement [musique: piano doux] et voilà la suite")
        self.assertEqual(out, [])  # sans le correctif : coupé après « [musique: »
        self.assertTrue(s.flush()[0].endswith("[musique: piano doux] et voilà la suite"))

    def test_cleans_unspeakable_text(self):
        self.assertEqual(clean_for_tts("- **Salut** 👋 voir https://x.y/z"), "Salut voir")

    def test_multipart_shape(self):
        body, ctype = multipart({"model": "m", "language": "fr"}, "a.wav", b"RIFF", "audio/wav")
        boundary = ctype.split("boundary=")[1]
        self.assertIn(b'name="model"\r\n\r\nm\r\n', body)
        self.assertIn(b'filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n', body)
        self.assertTrue(body.endswith(f"--{boundary}--\r\n".encode()))

    def test_prune_drops_oldest_first_but_spares_recent_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, old = Path(tmp), time.time() - KEEP_RECENT - 60
            for name, mtime in [("a", old - 10), ("b", old), ("c", time.time())]:
                (folder / name).write_bytes(b"x" * 100)
                os.utime(folder / name, (mtime, mtime))
            prune(folder, 200)
            self.assertEqual(sorted(f.name for f in folder.iterdir()), ["b", "c"])
            prune(folder, 0)
            self.assertEqual([f.name for f in folder.iterdir()], ["c"])  # too recent to go

    def test_cut_off_answer_stays_quiet_but_is_remembered(self):
        events, face = [], types.SimpleNamespace(clip=lambda *a: None)
        brain = Brain({"GROQ_API_KEY": "x", "PERSONA_FILE": ""}, FakeTTS(), face, lambda e, d: events.append((e, d)))
        turn = brain._new_turn()

        def stream(_messages):
            yield "Première phrase. Deu"
            brain.cancel()  # someone cuts him off
            yield "xième phrase."

        brain.reply_stream = stream
        brain._answer(turn, "Salut")
        self.assertNotIn("done", [d.get("stage") for e, d in events if e == "brain"])
        self.assertEqual(brain.memory.history, [{"role": "user", "content": "Salut"}, {"role": "assistant", "content": "Première phrase."}])

    def test_retired_groq_model_is_replaced(self):
        import brain as brain_mod
        cfg = {"GROQ_API_KEY": "x", "PERSONA_FILE": "", "LLM_MODEL": "old-big", "LLM_FALLBACK_MODEL": "old-small"}
        brain = Brain(cfg, FakeTTS(), types.SimpleNamespace(clip=lambda *a: None), lambda e, d: None)
        tried = []

        def chat(_key, model, _messages, **_kw):
            tried.append(model)
            if model.startswith("old"):
                raise urllib.error.HTTPError("u", 404, "model_not_found", None, None)
            yield "Salut."

        listed = ["whisper-large-v3", "llama-3.3-70b-versatile", "new-thing"]
        real_chat, real_list = brain_mod.stream_chat, brain_mod.list_models
        brain_mod.stream_chat, brain_mod.list_models = chat, lambda *_a: listed
        try:
            self.assertEqual("".join(brain.reply_stream([])), "Salut.")
            self.assertEqual(tried, ["old-big", "old-small", "llama-3.3-70b-versatile"])
            self.assertEqual(cfg["LLM_MODEL"], "llama-3.3-70b-versatile")  # kept for the next sentences
            listed.append("old-big")  # still listed: the failure is elsewhere (quota, network), nothing to heal
            cfg.update(LLM_MODEL="old-big", LLM_FALLBACK_MODEL="")
            with self.assertRaises(RuntimeError):
                "".join(brain.reply_stream([]))
        finally:
            brain_mod.stream_chat, brain_mod.list_models = real_chat, real_list


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cfg = load_config()
        cfg.update(HOST="127.0.0.1", GROQ_API_KEY="", LLM_URL="", BRIEF_CITY="", FACE_URL="", MEMORY_DIR="",  # never the real memory
                   ELI_LANG="fr", STT_LANGUAGE="", LYRICS="off")  # no LRCLIB calls from tests
        cls.server = make_server(cfg, port=0, tts=FakeTTS(), with_stems=False)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.tmp = tempfile.TemporaryDirectory()  # never the real local/navidrome.json
        app = cls.server.app
        app.music = app.brain.music = Navidrome(Path(cls.tmp.name) / "navidrome.json", {})
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.events: list[tuple[str, dict]] = []
        threading.Thread(target=cls._listen, daemon=True).start()
        time.sleep(0.3)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    @classmethod
    def _listen(cls):
        event = None
        with urllib.request.urlopen(cls.base + "/events") as r:
            for raw in r:
                line = raw.decode().strip()
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    cls.events.append((event, json.loads(line[5:])))

    def post(self, path, body=b"", ctype="application/json", headers=None):
        req = urllib.request.Request(self.base + path, data=body, headers={"Content-Type": ctype, **(headers or {})}, method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def wait_for(self, event, pred=lambda d: True, timeout=3.0):
        end = time.time() + timeout
        while time.time() < end:
            for name, data in list(self.events):
                if name == event and pred(data):
                    return data
            time.sleep(0.05)
        self.fail(f"no {event} event")

    def test_clip_roundtrip(self):
        code, meta = self.post("/clip?kind=speech", tiny_wav(), "audio/wav", {"X-Text": "Salut%20%C3%A7a%20va"})
        self.assertEqual(code, 200)
        self.wait_for("clip", lambda d: d["id"] == meta["id"] and d["text"] == "Salut ça va")
        with urllib.request.urlopen(self.base + meta["url"]) as r:
            self.assertEqual(r.read()[:4], b"RIFF")

    def test_voice_choice_rejects_unknown_voices(self):
        with urllib.request.urlopen(self.base + "/api/voices") as r:
            self.assertEqual(json.loads(r.read())["voices"], [])  # the fake voice can't be chosen
        code, _ = self.post("/voice", json.dumps({"id": "../../etc"}).encode())
        self.assertEqual(code, 400)

    def test_brain_settings_local_llm_then_back_to_groq(self):
        import app as app_module

        class Models(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"data": [{"id": "qwen3-8b"}]}).encode() if self.path == "/v1/models" else b"{}"
                self.send_response(200 if self.path == "/v1/models" else 404)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        fake = ThreadingHTTPServer(("127.0.0.1", 0), Models)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        saved_cfg, saved_data = dict(self.server.app.cfg), app_module.DATA
        with tempfile.TemporaryDirectory() as tmp:
            app_module.DATA = Path(tmp)  # never the real .env
            try:
                code, body = self.post("/key", json.dumps({"groq": "sk-not-groq"}).encode())
                self.assertEqual((code, body["error"]), (400, "not a Groq key (gsk_…)"))
                url = f"http://127.0.0.1:{fake.server_address[1]}/v1"
                code, body = self.post("/key", json.dumps({"llm_url": url}).encode())
                self.assertEqual((code, body["llm"], body["llm_url"]), (200, "qwen3-8b", url))  # first model listed
                env = (Path(tmp) / ".env").read_text()
                self.assertIn(f"LLM_URL={url}\n", env)
                self.assertEqual((Path(tmp) / ".env").stat().st_mode & 0o777, 0o600)
                with urllib.request.urlopen(self.base + "/api/models") as r:  # the picker in Settings > Brain
                    self.assertEqual(json.loads(r.read()), {"current": "qwen3-8b", "models": ["qwen3-8b"]})
                code, body = self.post("/key", json.dumps({"model": "qwen3-4b"}).encode())
                self.assertEqual((code, body["llm"]), (200, "qwen3-4b"))
                self.assertIn("LLM_MODEL=qwen3-4b\n", (Path(tmp) / ".env").read_text())
                code, _ = self.post("/key", json.dumps({"model": "x\nGROQ_API_KEY=evil"}).encode())
                self.assertEqual(code, 400)
                code, body = self.post("/key", json.dumps({"llm_url": "http://x/v1\nGROQ_API_KEY=evil"}).encode())
                self.assertEqual(code, 400)
                code, body = self.post("/key", json.dumps({"llm_url": ""}).encode())
                self.assertEqual((code, body["llm"], body["llm_url"]), (200, None, ""))  # no Groq key in tests: no brain
                self.assertNotIn("evil", (Path(tmp) / ".env").read_text())
            finally:
                app_module.DATA = saved_data
                self.server.app.cfg.clear()
                self.server.app.cfg.update(saved_cfg)
                fake.shutdown()

    @unittest.skipUnless(FFMPEG, "no ffmpeg")
    def test_undecodable_clip_is_converted_to_aac(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, alac = Path(tmp) / "a.wav", Path(tmp) / "a.m4a"
            src.write_bytes(tiny_wav(0.5))
            subprocess.run([FFMPEG, "-v", "error", "-i", str(src), "-c:a", "alac", str(alac)], check=True)
            code, meta = self.post("/clip?kind=music&name=a.m4a", alac.read_bytes(), "audio/mp4")
        self.assertEqual(code, 200)
        with urllib.request.urlopen(self.base + meta["url"] + "?compat=1") as r:  # the ALAC Chrome refuses
            self.assertEqual(r.headers["Content-Type"], "audio/mp4")
            body = r.read()
        self.assertGreater(len(body), 500)
        probe = subprocess.run([FFMPEG, "-v", "error", "-i", "-", "-f", "null", "-"], input=body, capture_output=True)
        self.assertEqual(probe.returncode, 0, probe.stderr)  # a real, decodable file

    def test_speak_goes_through_the_face_protocol(self):
        code, body = self.post("/brain/speak", json.dumps({"text": "Bonjour toi."}).encode())
        self.assertEqual(code, 202)
        turn = body["turn"]
        self.wait_for("stop", lambda d: d["turn"] == turn)  # a new turn silences the old one
        self.wait_for("clip", lambda d: d["text"] == "Bonjour toi." and d["kind"] == "speech" and d["turn"] == turn)

    def test_speech_carries_phonemes_and_hides_english_tags(self):
        self.post("/brain/speak", json.dumps({"text": "J'adore [en]Two People[/en]."}).encode())
        clip = self.wait_for("clip", lambda d: d["text"] == "J'adore Two People.")
        self.assertEqual(clip["phonemes"], [["b", 40], ["ɔ", 80]])
        bad = {"X-Phonemes": "%5B%5B1%2C2%5D%5D"}  # [[1,2]]: ignored, the mouth will follow the sound
        code, meta = self.post("/clip?kind=speech", tiny_wav(), "audio/wav", bad)
        self.assertNotIn("phonemes", self.wait_for("clip", lambda d: d["id"] == meta["id"]))

    def test_intro_asks_questions_and_cats_meow(self):
        code, body = self.post("/brain/intro")
        self.assertEqual(code, 202)
        self.wait_for("clip", lambda d: d["turn"] == body["turn"] and "comment tu t'appelles" in d["text"])
        self.assertEqual(self.server.app.brain.intro_left, 5)
        self.server.app.brain.reset()
        self.post("/theme", json.dumps({"id": "chat-pixel"}).encode())
        code, body = self.post("/brain/meow")
        self.wait_for("clip", lambda d: d["turn"] == body["turn"] and d["text"] == "Miaou !")

    def test_hotword_only_answers_when_named(self):
        app = self.server.app
        self.assertEqual(self.post("/brain/hotword", b"RIFFnope", "audio/wav")[0], 400)
        heard = {"maybe": False, "text": ""}
        app.hotword.maybe = lambda pcm: heard["maybe"]
        app.brain.transcribe = lambda wav: (heard["text"], "fake")
        self.assertEqual(self.post("/brain/hotword", tiny_wav(2.0), "audio/wav")[1], {"wake": False})
        heard["maybe"] = True
        self.assertEqual(self.post("/brain/hotword", tiny_wav(0.6), "audio/wav")[1], {"wake": True, "listen": True})
        heard["text"] = "Il y a du monde."
        self.assertEqual(self.post("/brain/hotword", tiny_wav(2.0), "audio/wav")[1], {"wake": False})
        heard["text"] = "Hé Eli, dis bonjour."
        code, body = self.post("/brain/hotword", tiny_wav(2.0), "audio/wav")
        self.assertTrue(body["wake"] and body["turn"])
        self.wait_for("brain", lambda d: d.get("stage") == "heard" and d["text"] == "Hé Eli, dis bonjour.")

    def test_mood_tags_reach_the_face_unspoken(self):
        brain = self.server.app.brain
        brain.cancel()
        songs: list[str] = []
        brain._sentence(brain.turn, "[joie] Trop bien ! [musique: Daft Punk]", [], songs)
        clip = self.wait_for("clip", lambda d: d["text"] == "Trop bien !")
        self.assertEqual((clip["mood"], songs), ("joie", ["Daft Punk"]))
        code, meta = self.post("/clip?kind=speech", tiny_wav(), "audio/wav", {"X-Mood": "rage"})  # unknown: ignored
        self.assertNotIn("mood", self.wait_for("clip", lambda d: d["id"] == meta["id"]))

    def test_english_tags_and_lines(self):
        with urllib.request.urlopen(self.base + "/api/status") as r:
            self.assertEqual({k: v for k, v in json.loads(r.read()).items() if "lang" in k}, {"lang": "fr", "lang_setting": "fr"})
        self.assertEqual(self.post("/lang", json.dumps({"lang": "de"}).encode())[0], 400)
        self.assertEqual(self.post("/lang", json.dumps({"lang": "en"}).encode())[0], 200)
        try:
            self.wait_for("lang", lambda d: d["lang"] == "en")
            brain = self.server.app.brain
            brain.cancel()
            songs: list[str] = []
            brain._sentence(brain.turn, "[joy] Great! [music: Daft Punk]", [], songs)
            clip = self.wait_for("clip", lambda d: d["text"] == "Great!")
            self.assertEqual((clip["mood"], songs), ("joie", ["Daft Punk"]))
            self.post("/brain/chat", json.dumps({"text": "Hi"}).encode())
            self.wait_for("clip", lambda d: "Groq key" in d["text"])
        finally:
            self.post("/lang", json.dumps({"lang": "fr"}).encode())

    def test_music_without_library_opens_the_form(self):
        brain = self.server.app.brain
        brain.cancel()
        brain._play(brain.turn, "Daft Punk")
        self.wait_for("setup", lambda d: d["need"] == "navidrome")
        with urllib.request.urlopen(self.base + "/api/music") as r:
            self.assertFalse(json.loads(r.read())["configured"])
        code, body = self.post("/music/setup", json.dumps({"url": "ftp://x", "user": "u", "password": "p"}).encode())
        self.assertEqual(code, 400)
        code, _ = self.post("/music/setup", json.dumps({"url": "http://127.0.0.1:9", "user": "u", "password": "p"}).encode())
        self.assertEqual(code, 400)  # unreachable: nothing is saved
        self.assertFalse(Path(self.tmp.name, "navidrome.json").exists())
        self.assertEqual(self.post("/music/forget")[1]["configured"], False)

    def test_picker_searches_and_sings_a_library_song(self):
        song = {"id": "s1", "title": "Get Lucky", "artist": "Daft Punk", "album": "RAM", "genre": "Disco", "coverArt": "al-1"}

        class Subsonic(BaseHTTPRequestHandler):  # a tiny Navidrome: just what the picker calls
            def do_GET(self):
                view = self.path.split("/rest/")[1].split(".view")[0]
                if view in ("stream", "getCoverArt"):
                    body, ctype = (tiny_wav() if view == "stream" else b"\xff\xd8jpeg"), "application/octet-stream"
                else:
                    extra = {"search3": {"searchResult3": {"song": [song]}}, "getSong": {"song": song},
                             "ping": {"type": "navidrome", "serverVersion": "0.53"}}.get(view, {})
                    body, ctype = json.dumps({"subsonic-response": {"status": "ok", **extra}}).encode(), "application/json"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        fake = ThreadingHTTPServer(("127.0.0.1", 0), Subsonic)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{fake.server_address[1]}"
            code, body = self.post("/music/setup", json.dumps({"url": url, "user": "u", "password": "p"}).encode())
            self.assertEqual((code, body["server"]), (200, "navidrome 0.53"))
            with urllib.request.urlopen(self.base + "/api/music/songs?q=lucky") as r:
                self.assertEqual(json.loads(r.read())["songs"][0]["cover"], "al-1")
            with urllib.request.urlopen(self.base + "/music/cover/al-1") as r:
                self.assertEqual(r.read(), b"\xff\xd8jpeg")
            self.assertEqual(self.post("/music/play", json.dumps({"id": "../x"}).encode())[0], 400)
            self.assertEqual(self.post("/music/play", json.dumps({"id": "s1"}).encode())[0], 200)
            self.wait_for("clip", lambda d: d["kind"] == "music" and d["name"] == "Daft Punk – Get Lucky.mp3")
            self.assertEqual(self.post("/music/ping")[1]["server"], "navidrome 0.53")
        finally:
            self.post("/music/forget")
            fake.shutdown()

    def test_esc_keeps_a_song_on_its_way(self):
        """Downloading a song takes seconds: cutting his speech (Esc) must not lose it, a real stop does."""
        brain, started, gate, sent = self.server.app.brain, threading.Event(), threading.Event(), []

        class Music:  # a slow download
            def fetch(self, _id):
                started.set()
                gate.wait(5)
                return b"mp3"

        class Face:
            def clip(self, *args, **_kw):
                sent.append(args)

        saved = brain.music, brain.face
        brain.music, brain.face = Music(), Face()
        try:
            for keep, arrives in (("music", 1), (None, 0)):
                sent.clear(), started.clear(), gate.clear()
                job = threading.Thread(target=brain.sing, args=({"id": "s", "title": "T", "artist": "A"},))
                job.start()
                started.wait(5)
                brain.cancel(keep)
                gate.set()
                job.join(5)
                self.assertEqual(len(sent), arrives, f"keep={keep}")
                if sent:
                    self.assertEqual(sent[0][3], 0)  # turn 0: no later turn makes the page drop it
        finally:
            brain.music, brain.face = saved

    def test_previous_next(self):
        """Previous / next walk the songs sung; past the end, a random one; a song is never read out, only played."""
        brain, sent = self.server.app.brain, []
        song = lambda i: {"id": f"s{i}", "title": f"T{i}", "artist": "A"}  # noqa: E731

        class Music:
            def fetch(self, _id):
                return b"mp3"

            def songs(self, _q):
                return [song(2), song(9)]

        class Face:
            def clip(self, *args, **_kw):
                sent.append(args)

        class Tts:
            def synth(self, text, _cat):
                return b"wav", []

        saved = brain.music, brain.face, brain.tts, brain.played, brain.place
        brain.music, brain.face, brain.tts, brain.played, brain.place = Music(), Face(), Tts(), [], -1
        try:
            self.assertEqual(brain.step(-1), (None, False))
            brain.sing(song(1))
            self.assertEqual([a[1] for a in sent], ["music"])
            self.assertIn("T1", sent[0][2])
            brain.sing(song(2))
            self.assertEqual(brain.step(-1), (song(1), False))
            self.assertEqual(brain.step(-1), (song(1), False), "previous on the first song starts it again")
            self.assertEqual(brain.step(1), (song(2), False))
            self.assertEqual(brain.step(1), (song(9), True), "past the end: a random one, not the same")
            brain.step(-1)
            brain.sing(song(5))
            self.assertEqual([x["id"] for x in brain.played], ["s1", "s5"], "a new song drops what came after")
            fetches = []

            def slow(song_id):
                fetches.append(song_id)
                if len(fetches) == 1:
                    brain.sing(song(7))  # asked again mid-download
                return b"mp3"

            brain.music.fetch, sent[:] = slow, []
            brain.sing(song(7))
            self.assertEqual(fetches, ["s7"], "the same song asked during its download doesn't restart it")
            self.assertEqual([a[1] for a in sent], ["music"])
            brain.sing(song(7))
            self.assertEqual(len(fetches), 2, "once it played, asking again plays it again")

            brain.music.auth = True
            brain.music.find = lambda _q, avoid=(): song(7)  # the LLM names the song playing again
            brain.music.similar = lambda now, avoid=(): song(8) if now["id"] == "s7" else None
            for query in ("Artist T7", "pareil"):
                sent[:] = []
                brain._play(brain.turn, query)
                self.assertIn("T8", sent[0][2], f"{query!r}: another one like it, not the same again")
                brain.sing(song(7))
        finally:
            brain.music, brain.face, brain.tts, brain.played, brain.place = saved

    def test_brief_runs_a_turn(self):
        code, body = self.post("/brain/brief")
        self.assertEqual(code, 202)
        self.wait_for("clip", lambda d: d["turn"] == body["turn"] and "cerveau" in d["text"])  # without an LLM, he says so

    def test_human_stop_cancels_the_turn(self):
        self.assertEqual(self.post("/stop")[0], 200)
        self.wait_for("stop", lambda d: d["turn"] == self.server.app.brain.turn)
        self.assertEqual(self.post("/stop", json.dumps({"turn": "x"}).encode())[0], 400)

    def test_chat_without_key_says_so(self):
        self.post("/brain/chat", json.dumps({"text": "Coucou"}).encode())
        self.wait_for("clip", lambda d: "clé Groq" in d["text"])
        self.wait_for("state", lambda d: d["mode"] == "idle")

    def test_rejects_bad_input(self):
        self.assertEqual(self.post("/state", json.dumps({"mode": "danse"}).encode())[0], 400)
        self.assertEqual(self.post("/theme", json.dumps({"id": "../x"}).encode())[0], 400)
        self.assertEqual(self.post("/clip?kind=video", tiny_wav(), "audio/wav")[0], 400)
        self.assertEqual(self.post("/clip", b"hello", "text/plain")[0], 415)
        self.assertEqual(self.post("/gaze", json.dumps({"x": "a"}).encode())[0], 400)

    def test_blocks_other_sites(self):
        code, _ = self.post("/brain/speak", json.dumps({"text": "pirate"}).encode(), headers={"Origin": "https://evil.example"})
        self.assertEqual(code, 403)

    def test_domain_names_need_allowed_hosts(self):
        def status(host):
            req = urllib.request.Request(self.base + "/api/status", headers={"Host": host})
            try:
                return urllib.request.urlopen(req).status
            except urllib.error.HTTPError as err:
                return err.code
        self.assertEqual(status("eli.tail1.ts.net"), 403)
        self.server.app.cfg["ALLOWED_HOSTS"] = "eli.tail1.ts.net"
        try:
            self.assertEqual(status("eli.tail1.ts.net"), 200)
        finally:
            self.server.app.cfg["ALLOWED_HOSTS"] = ""

    def test_no_path_traversal(self):
        with self.assertRaises(urllib.error.HTTPError) as err:
            urllib.request.urlopen(self.base + "/../.env")
        self.assertEqual(err.exception.code, 404)

    def test_take_silences_the_other_pages(self):
        self.assertEqual(self.post("/take", json.dumps({"client": "tab-b"}).encode())[0], 200)
        self.wait_for("take", lambda d: d["client"] == "tab-b")

    def test_logs_are_numbered_and_versioned(self):
        logging.getLogger("eli.test").warning("hello from the test, key=gsk_abcdef123456")
        with urllib.request.urlopen(self.base + "/api/logs?after=0") as r:
            data = json.loads(r.read())
        self.assertTrue(data["version"])
        line = next(l for l in data["lines"] if "hello from the test" in l["msg"])
        self.assertNotIn("gsk_abcdef123456", line["msg"])
        with urllib.request.urlopen(self.base + f"/api/logs?after={line['n']}") as r:
            self.assertNotIn(line["n"], [l["n"] for l in json.loads(r.read())["lines"]])
        with urllib.request.urlopen(self.base + f"/api/logs?after={line['n']}&boot=another") as r:
            self.assertIn(line["n"], [l["n"] for l in json.loads(r.read())["lines"]], "another server's count: from 0")

    def test_song_genre_dresses_eli(self):
        code, meta = self.post("/clip?kind=music&name=song.wav", tiny_wav(), "audio/wav", {"X-Genre": "Tropical%20House"})
        self.assertEqual(code, 200)
        self.wait_for("genre", lambda d: d["id"] == meta["id"] and d["look"] == "tropical")

    def test_gaze_and_theme_are_broadcast(self):
        self.post("/gaze", json.dumps({"x": 2, "y": -0.5}).encode())
        self.wait_for("gaze", lambda d: d["gaze"] == {"x": 1.0, "y": -0.5})
        self.post("/theme", json.dumps({"id": "trait-neon"}).encode())
        self.wait_for("theme", lambda d: d["id"] == "trait-neon")


if __name__ == "__main__":
    unittest.main()

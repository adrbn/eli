"""Vérifs du serveur : `uv run python -m unittest discover server`."""
from __future__ import annotations

import io
import json
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
    name = "fausse voix"

    def synth(self, text: str, cat: bool = False) -> tuple[bytes, list]:
        return tiny_wav(), [["b", 40], ["ɔ", 80]]


class VoicesTest(unittest.TestCase):
    def test_lists_piper_and_mac_voices_and_falls_back_without_model(self):
        from voice import Voices
        with tempfile.TemporaryDirectory() as tmp:
            voices = Voices(Path(tmp), "siwis", "Thomas")  # modèle absent : say, sans télécharger au démarrage
            self.assertEqual(voices.current, "say:Thomas")
            ids = [v["id"] for v in voices.catalog()["voices"]]
            self.assertIn("pierre", ids)
            with self.assertRaises(ValueError):
                voices.choose("inconnue")
            voices.set_cat(True)
            self.assertTrue(Voices(Path(tmp), "siwis", "Thomas").catalog()["cat"])  # le filtre chat est retenu


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
            self.assertEqual([f.name for f in folder.iterdir()], ["c"])  # trop récent pour partir

    def test_cut_off_answer_stays_quiet_but_is_remembered(self):
        events, face = [], types.SimpleNamespace(clip=lambda *a: None)
        brain = Brain({"GROQ_API_KEY": "x", "PERSONA_FILE": ""}, FakeTTS(), face, lambda e, d: events.append((e, d)))
        turn = brain._new_turn()

        def stream(_messages):
            yield "Première phrase. Deu"
            brain.cancel()  # on lui coupe la parole
            yield "xième phrase."

        brain.reply_stream = stream
        brain._answer(turn, "Salut")
        self.assertNotIn("done", [d.get("stage") for e, d in events if e == "brain"])
        self.assertEqual(brain.memory.history, [{"role": "user", "content": "Salut"}, {"role": "assistant", "content": "Première phrase."}])


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cfg = load_config()
        cfg.update(HOST="127.0.0.1", GROQ_API_KEY="", LLM_URL="", BRIEF_CITY="", FACE_URL="", MEMORY_DIR="")  # jamais la vraie mémoire
        cls.server = make_server(cfg, port=0, tts=FakeTTS(), with_stems=False)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.tmp = tempfile.TemporaryDirectory()  # jamais le vrai local/navidrome.json
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
        self.fail(f"pas d'événement {event}")

    def test_clip_roundtrip(self):
        code, meta = self.post("/clip?kind=speech", tiny_wav(), "audio/wav", {"X-Text": "Salut%20%C3%A7a%20va"})
        self.assertEqual(code, 200)
        self.wait_for("clip", lambda d: d["id"] == meta["id"] and d["text"] == "Salut ça va")
        with urllib.request.urlopen(self.base + meta["url"]) as r:
            self.assertEqual(r.read()[:4], b"RIFF")

    def test_voice_choice_rejects_unknown_voices(self):
        with urllib.request.urlopen(self.base + "/api/voices") as r:
            self.assertEqual(json.loads(r.read())["voices"], [])  # la fausse voix ne se choisit pas
        code, _ = self.post("/voice", json.dumps({"id": "../../etc"}).encode())
        self.assertEqual(code, 400)

    @unittest.skipUnless(FFMPEG, "ffmpeg absent")
    def test_undecodable_clip_is_converted_to_mp3(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, alac = Path(tmp) / "a.wav", Path(tmp) / "a.m4a"
            src.write_bytes(tiny_wav(0.5))
            subprocess.run([FFMPEG, "-v", "error", "-i", str(src), "-c:a", "alac", str(alac)], check=True)
            code, meta = self.post("/clip?kind=music&name=a.m4a", alac.read_bytes(), "audio/mp4")
        self.assertEqual(code, 200)
        with urllib.request.urlopen(self.base + meta["url"] + "?compat=1") as r:  # l'ALAC que Chrome refuse
            self.assertEqual(r.headers["Content-Type"], "audio/mpeg")
            self.assertGreater(len(r.read()), 500)

    def test_speak_goes_through_the_face_protocol(self):
        code, body = self.post("/brain/speak", json.dumps({"text": "Bonjour toi."}).encode())
        self.assertEqual(code, 202)
        turn = body["turn"]
        self.wait_for("stop", lambda d: d["turn"] == turn)  # un nouveau tour fait taire l'ancien
        self.wait_for("clip", lambda d: d["text"] == "Bonjour toi." and d["kind"] == "speech" and d["turn"] == turn)

    def test_speech_carries_phonemes_and_hides_english_tags(self):
        self.post("/brain/speak", json.dumps({"text": "J'adore [en]Two People[/en]."}).encode())
        clip = self.wait_for("clip", lambda d: d["text"] == "J'adore Two People.")
        self.assertEqual(clip["phonemes"], [["b", 40], ["ɔ", 80]])
        bad = {"X-Phonemes": "%5B%5B1%2C2%5D%5D"}  # [[1,2]] : ignoré, la bouche suivra le son
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
        code, meta = self.post("/clip?kind=speech", tiny_wav(), "audio/wav", {"X-Mood": "rage"})  # inconnue : ignorée
        self.assertNotIn("mood", self.wait_for("clip", lambda d: d["id"] == meta["id"]))

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
        self.assertEqual(code, 400)  # injoignable : rien n'est enregistré
        self.assertFalse(Path(self.tmp.name, "navidrome.json").exists())
        self.assertEqual(self.post("/music/forget")[1]["configured"], False)

    def test_brief_runs_a_turn(self):
        code, body = self.post("/brain/brief")
        self.assertEqual(code, 202)
        self.wait_for("clip", lambda d: d["turn"] == body["turn"] and "cerveau" in d["text"])  # sans LLM, il le dit

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

    def test_gaze_and_theme_are_broadcast(self):
        self.post("/gaze", json.dumps({"x": 2, "y": -0.5}).encode())
        self.wait_for("gaze", lambda d: d["gaze"] == {"x": 1.0, "y": -0.5})
        self.post("/theme", json.dumps({"id": "trait-neon"}).encode())
        self.wait_for("theme", lambda d: d["id"] == "trait-neon")


if __name__ == "__main__":
    unittest.main()

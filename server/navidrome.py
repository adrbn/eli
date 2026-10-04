"""Your music, from Navidrome (or any Subsonic server): "Eli, play some Daft Punk".

Access is set from the page (Settings → Music), or Eli asks for it the first time he's asked for a song.
The password is never kept: only a Subsonic token (md5(password + salt) and its salt), in local/navidrome.json,
outside the repo.
"""
from __future__ import annotations

import hashlib
import json
import random
import time
import re
import unicodedata
import secrets
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

CLIENT = "eli"
JOIN = re.compile(r"\s+(?:et|and|&|x|feat\.?|ft\.?|avec|with|featuring)\s+", re.I)  # "A et B", "A feat. B"…
NAMES = re.compile(r"\s*(?:•|,|&|/|;)\s*|\s+(?:feat\.?|ft\.?|x|et|and|with|avec)\s+")  # "A • B", "A feat. B": one name each
BITRATE = 128  # kb/s: a 4 min song ≈ 4 MB, reasonable even through a slow VPN

SURE, MAYBE = 0.8, 0.6  # ponytail: fixed thresholds, tuned on a handful of mishearings


def _sound(word: str) -> str:
    """A crude sound key, French ears on English names: accents, "au"→"o", silent w/h, doubled letters, final e/s."""
    w = unicodedata.normalize("NFKD", word.casefold()).encode("ascii", "ignore").decode()
    w = re.sub(r"[wh]", "", w.replace("eau", "o").replace("au", "o"))
    return re.sub(r"(.)\1+", r"\1", w).rstrip("es") or w


def sound_score(words: list[str], artist: str, title: str) -> float:
    """0..1: how well the worst spoken word (3 letters or more) sounds like some word of the song, or its whole artist
    name glued. The worst, not the mean: a perfect "Stromae" must not carry a "Formidable" the library doesn't have."""
    hay = [_sound(h) for h in re.findall(r"\w+", f"{artist} {title}")] + [_sound("".join(re.findall(r"\w+", artist)))]
    return min((max(SequenceMatcher(None, _sound(w), h).ratio() for h in hay) for w in words if len(w) > 2), default=0.0)


class MusicError(Exception):
    """A message ready to show."""


class Navidrome:
    def __init__(self, file: Path, env: dict):
        self.file = file
        self.auth = json.loads(file.read_text()) if file.exists() else None
        if not self.auth and env.get("NAVIDROME_URL") and env.get("NAVIDROME_USER") and env.get("NAVIDROME_PASSWORD"):
            self.auth = self._token(env["NAVIDROME_URL"], env["NAVIDROME_USER"], env["NAVIDROME_PASSWORD"])

    @staticmethod
    def _token(url: str, user: str, password: str) -> dict:
        salt = secrets.token_hex(8)
        return {"url": url.rstrip("/"), "user": user, "salt": salt,
                "token": hashlib.md5((password + salt).encode()).hexdigest()}

    def status(self) -> dict:
        a = self.auth or {}
        return {"configured": bool(self.auth), "url": a.get("url"), "user": a.get("user"), "server": a.get("server")}

    def _url(self, auth: dict, view: str, **params) -> str:
        query = {"u": auth["user"], "t": auth["token"], "s": auth["salt"], "v": "1.16.1", "c": CLIENT, "f": "json", **params}
        return f"{auth['url']}/rest/{view}.view?{urllib.parse.urlencode(query)}"

    def _call(self, auth: dict, view: str, timeout: float = 10, **params) -> dict:
        try:
            with urllib.request.urlopen(self._url(auth, view, **params), timeout=timeout) as r:
                body = json.loads(r.read())["subsonic-response"]
        except (OSError, ValueError, KeyError) as exc:
            raise MusicError(f"music server unreachable ({getattr(exc, 'reason', exc)}): check the address and port") from exc
        if body.get("status") != "ok":
            raise MusicError("credentials refused" if body.get("error", {}).get("code") in (40, 41)
                             else body.get("error", {}).get("message", "music server error"))
        return body

    def setup(self, url: str, user: str, password: str) -> dict:
        parsed = urllib.parse.urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise MusicError("invalid address: http(s)://server:port")
        if not user.strip() or not password or len(password) > 200 or len(user) > 100:
            raise MusicError("user and password required")
        auth = self._token(url.strip(), user.strip(), password)
        auth["server"] = self._server(self._call(auth, "ping"))  # checks before saving
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(auth))
        self.file.chmod(0o600)
        self.auth = auth
        return self.status()

    @staticmethod
    def _server(pong: dict) -> str:
        """E.g. "navidrome 0.53.3", or "subsonic 1.16.1" for a server that doesn't say more."""
        return f"{pong.get('type', 'subsonic')} {pong.get('serverVersion') or pong.get('version', '')}".strip()

    def ping(self) -> dict:
        """Settings → Music → Test: is the server answering, and how fast."""
        if not self.auth:
            raise MusicError("no music library configured")
        start = time.monotonic()
        server = self._server(self._call(self.auth, "ping", timeout=6))
        return {"ok": True, "server": server, "ms": round((time.monotonic() - start) * 1000)}

    def songs(self, query: str = "") -> list[dict]:
        """The picker: up to 40 songs matching `query`, or a random handful when it's empty."""
        if not self.auth:
            raise MusicError("no music library configured")
        found = (self._search(query, 40) if query.strip()
                 else self._call(self.auth, "getRandomSongs", size=24).get("randomSongs", {}).get("song", []))
        return [self._song(x) for x in found]

    def song(self, song_id: str) -> dict:
        if not self.auth:
            raise MusicError("no music library configured")
        return self._song(self._call(self.auth, "getSong", id=song_id)["song"])

    def cover(self, cover_id: str, size: int = 120) -> bytes:
        """Album art, fetched here so the token never reaches the page."""
        try:
            with urllib.request.urlopen(self._url(self.auth, "getCoverArt", id=cover_id, size=size), timeout=10) as r:
                return r.read(2 * 1024 * 1024)
        except OSError as exc:
            raise MusicError(f"no cover ({exc})") from exc

    @staticmethod
    def _song(x: dict) -> dict:
        return {"id": x["id"], "title": x.get("title", "?"), "artist": x.get("artist", ""), "album": x.get("album", ""),
                "genre": x.get("genre"), "duration": x.get("duration"), "cover": x.get("coverArt")}

    def forget(self) -> None:
        self.file.unlink(missing_ok=True)
        self.auth = None

    def find(self, query: str, avoid: frozenset[str] | set[str] = frozenset()) -> dict | None:
        """The best song for this request: {id, title, artist, genre}, or None. avoid: ids just played."""
        if not self.auth:
            raise MusicError("no music library configured")
        bare = re.sub(r"\s+", " ", JOIN.sub(" ", query)).strip()  # Navidrome needs every word to match: drop "et", "feat"…
        songs = self._search(query, 30) or (bare != query.strip() and self._search(bare, 10)) or self._duet(query)
        if not songs:  # "play some jazz": not a title, maybe a genre
            songs = self._call(self.auth, "getRandomSongs", size=1, genre=query.strip().title()).get("randomSongs", {}).get("song", [])
        if not songs:  # misheard name ("Autonose" for Otto Knows): any word, ranked by how it sounds
            score, song = self.guess(query)
            return song if score >= SURE else None
        if not songs:
            return None
        return self._song(self._pick(query, songs, avoid))

    def similar(self, song: dict, avoid: frozenset[str] | set[str] = frozenset()) -> dict | None:
        """Another song in the same vein: same artist or same genre tag, never one just played (nor this one)."""
        if not self.auth:
            raise MusicError("no music library configured")
        artist = song.get("artist") or ""
        pool = [s for s in self._search(artist, 30) if s.get("artist") == artist] if artist else []
        tags = {song.get("genre"), *(s.get("genre") for s in pool)} - {None, ""}  # untagged song: its artist's genres
        for tag in sorted(tags)[:3]:
            pool += self._call(self.auth, "getRandomSongs", size=20, genre=tag).get("randomSongs", {}).get("song", [])
        avoid = {*avoid, song.get("id")}
        fresh = [s for s in pool if s.get("id") not in avoid]
        if not fresh:  # nothing alike in the library: a random one rather than the same again
            fresh = [s for s in self._call(self.auth, "getRandomSongs", size=10).get("randomSongs", {}).get("song", [])
                     if s.get("id") not in avoid]
        return self._song(random.choice(fresh)) if fresh else None

    @staticmethod
    def _pick(query: str, songs: list[dict], avoid: frozenset[str] | set[str] = frozenset()) -> dict:
        """Navidrome's first hit isn't always it ("Adele" → a duet featuring an Adèle): an artist named exactly (accents
        count) wins, and asking for that artist again gives another of their songs."""
        q = query.strip().casefold()
        exact = [s for s in songs if q in NAMES.split((s.get("artist") or "").casefold())]
        if not exact:
            return songs[0]
        return random.choice([s for s in exact if s.get("id") not in avoid] or exact)

    def guess(self, query: str) -> tuple[float, dict | None]:
        """The raw song that sounds most like the request, and how much (0..1): SURE plays it, MAYBE asks first."""
        words = re.findall(r"\w+", query)
        hits = {s.get("id"): s for w in words if len(w) > 2 for s in self._search(w, 50)}.values()
        scored = [(sound_score(words, s.get("artist") or "", s.get("title") or ""), s) for s in hits]
        score, best = max(scored, key=lambda x: x[0], default=(0.0, None))
        return score, best and self._song(best)

    def _duet(self, query: str) -> list[dict]:
        """"A et B": the server files a duet under one name only; prefer a hit that mentions the other one."""
        parts = [p for p in JOIN.split(query) if p.strip()]
        if len(parts) < 2:
            return []
        hits = [s for p in parts for s in self._search(p, 20)]
        both = [s for s in hits if sum(p.lower() in f"{s.get('artist', '')} {s.get('title', '')}".lower() for p in parts) > 1]
        return both or hits

    def _search(self, query: str, count: int) -> list[dict]:
        found = self._call(self.auth, "search3", query=query.strip()[:100], songCount=count, artistCount=0, albumCount=0)
        return found.get("searchResult3", {}).get("song", [])

    def stream(self, song_id: str, chunk: int = 64 * 1024):
        """The song as MP3, chunk by chunk as it arrives (60 MB at most): the face can start before the end."""
        try:
            with urllib.request.urlopen(self._url(self.auth, "stream", id=song_id, format="mp3", maxBitRate=BITRATE), timeout=90) as r:
                for _ in range(60 * 1024 * 1024 // chunk):
                    data = r.read(chunk)
                    if not data:
                        return
                    yield data
        except OSError as exc:
            raise MusicError(f"unreadable song ({exc})") from exc


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        nd = Navidrome(Path(tmp) / "n.json", {})
        assert nd.status() == {"configured": False, "url": None, "user": None, "server": None}
        assert Navidrome._server({"type": "navidrome", "serverVersion": "0.53"}) == "navidrome 0.53"
        assert Navidrome._server({"version": "1.16.1"}) == "subsonic 1.16.1"
        for bad in [("ftp://x", "u", "p"), ("http://x", "", "p")]:
            try:
                nd.setup(*bad)
                raise AssertionError(bad)
            except MusicError:
                pass
        auth = Navidrome._token("http://x:4533/", "u", "p")
        assert auth["token"] == hashlib.md5(("p" + auth["salt"]).encode()).hexdigest() and auth["url"] == "http://x:4533"
        assert "password" not in auth
    fake = Navidrome(Path(tmp) / "n.json", {})
    fake.auth = {"url": "x"}
    fake._search = lambda q, n: {"Arijit Singh": [{"id": "1", "artist": "Arijit Singh", "title": "Tum Hi Ho"},
                                                   {"id": "2", "artist": "Arijit Singh", "title": "Martin Garrix · In the End"}],
                                 "Martin Garrix": [{"id": "3", "artist": "Martin Garrix", "title": "Animals"}]}.get(q, [])
    fake._search = lambda q, n, real=fake._search: [{"id": "w", "artist": "B • A", "title": "W"}] if q == "A B" else real(q, n)
    assert fake.find("A et B")["id"] == "w" and fake.find("A feat. B")["id"] == "w"
    assert fake.find("Arijit Singh et Martin Garrix")["id"] == "2" and fake.find("Martin Garrix")["id"] == "3"
    hits = [{"id": "k", "artist": "Kyana • Adèle Castillon", "title": "Le masque"}, {"id": "a1", "artist": "Adele", "title": "Skyfall"},
            {"id": "a2", "artist": "Daniel Merriweather • Adele", "title": "Water"}]
    assert {Navidrome._pick("Adele", hits)["id"] for _ in range(40)} == {"a1", "a2"}, "the right Adele, and not always the same"
    assert Navidrome._pick("adele", hits, avoid={"a1"})["id"] == "a2"
    assert Navidrome._pick("Adèle Castillon", hits)["id"] == "k" and Navidrome._pick("Le masque", hits)["id"] == "k"
    lib = [{"id": "o", "artist": "Otto Knows", "title": "My Lover"}, {"id": "m", "artist": "MR TOUT LE MONDE", "title": "My Lover"},
           {"id": "t", "artist": "Taylor Swift", "title": "Lover"}]
    fake._search = lambda q, n: [s for s in lib if q.casefold() in f"{s['artist']} {s['title']}".casefold()]
    fake._call = lambda *a, **k: {}
    assert fake.find("My Lover Autonose")["id"] == "o" and fake.find("OTTOKNOWS My Lover")["id"] == "o"
    assert fake.find("Despacito Fonsi") is None, "no sound-alike: nothing rather than a random lover"
    print("ok")

"""Ta musique, depuis Navidrome (ou tout serveur Subsonic) : « Eli, mets du Daft Punk ».

L'accès se règle depuis la page (Réglages → Musique), ou Eli le demande la première fois qu'on lui réclame un
morceau. Le mot de passe n'est jamais gardé : seulement un jeton Subsonic (md5(mot de passe + sel) et son sel),
dans local/navidrome.json, hors du dépôt.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import urllib.parse
import urllib.request
from pathlib import Path

CLIENT = "eli"
BITRATE = 128  # kb/s : un morceau de 4 min ≈ 4 Mo, raisonnable même à travers un VPN lent


class MusicError(Exception):
    """Un message prêt à afficher."""


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
        return {"configured": bool(self.auth), "url": (self.auth or {}).get("url"), "user": (self.auth or {}).get("user")}

    def _url(self, auth: dict, view: str, **params) -> str:
        query = {"u": auth["user"], "t": auth["token"], "s": auth["salt"], "v": "1.16.1", "c": CLIENT, "f": "json", **params}
        return f"{auth['url']}/rest/{view}.view?{urllib.parse.urlencode(query)}"

    def _call(self, auth: dict, view: str, timeout: float = 10, **params) -> dict:
        try:
            with urllib.request.urlopen(self._url(auth, view, **params), timeout=timeout) as r:
                body = json.loads(r.read())["subsonic-response"]
        except (OSError, ValueError, KeyError) as exc:
            raise MusicError(f"serveur de musique injoignable ({getattr(exc, 'reason', exc)}) : vérifie l'adresse et le port") from exc
        if body.get("status") != "ok":
            raise MusicError("identifiants refusés" if body.get("error", {}).get("code") in (40, 41)
                             else body.get("error", {}).get("message", "erreur du serveur de musique"))
        return body

    def setup(self, url: str, user: str, password: str) -> dict:
        parsed = urllib.parse.urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise MusicError("adresse invalide : http(s)://serveur:port")
        if not user.strip() or not password or len(password) > 200 or len(user) > 100:
            raise MusicError("utilisateur et mot de passe requis")
        auth = self._token(url.strip(), user.strip(), password)
        self._call(auth, "ping")  # vérifie avant d'enregistrer
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(auth))
        self.file.chmod(0o600)
        self.auth = auth
        return self.status()

    def forget(self) -> None:
        self.file.unlink(missing_ok=True)
        self.auth = None

    def find(self, query: str) -> dict | None:
        """Le meilleur morceau pour cette demande : {id, title, artist}, ou None."""
        if not self.auth:
            raise MusicError("pas de bibliothèque musicale configurée")
        songs = self._call(self.auth, "search3", query=query, songCount=10, artistCount=0, albumCount=0)
        songs = songs.get("searchResult3", {}).get("song", [])
        if not songs:  # « mets du jazz » : ce n'est pas un titre, peut-être un genre
            songs = self._call(self.auth, "getRandomSongs", size=1, genre=query.strip().title()).get("randomSongs", {}).get("song", [])
        if not songs:
            return None
        s = songs[0]
        return {"id": s["id"], "title": s.get("title", "?"), "artist": s.get("artist", "")}

    def fetch(self, song_id: str) -> bytes:
        try:
            with urllib.request.urlopen(self._url(self.auth, "stream", id=song_id, format="mp3", maxBitRate=BITRATE), timeout=90) as r:
                return r.read(60 * 1024 * 1024)
        except OSError as exc:
            raise MusicError(f"morceau illisible ({exc})") from exc


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        nd = Navidrome(Path(tmp) / "n.json", {})
        assert nd.status() == {"configured": False, "url": None, "user": None}
        for bad in [("ftp://x", "u", "p"), ("http://x", "", "p")]:
            try:
                nd.setup(*bad)
                raise AssertionError(bad)
            except MusicError:
                pass
        auth = Navidrome._token("http://x:4533/", "u", "p")
        assert auth["token"] == hashlib.md5(("p" + auth["salt"]).encode()).hexdigest() and auth["url"] == "http://x:4533"
        assert "password" not in auth
    print("ok")

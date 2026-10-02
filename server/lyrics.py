"""Synced lyrics from LRCLIB (free, no key, https://lrclib.net) for the line Eli sings, shown under the face.

Artist and title come from the file's tags, or else from its name ("Kygo - Good For Me.mp3"). No synced lyrics
(unknown song, instrumental): None, and the page simply shows the title.
"""
from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path

log = logging.getLogger("eli.lyrics")
API = "https://lrclib.net/api"
AGENT = "Eli (https://github.com/adrbn/eli)"  # LRCLIB asks clients to name themselves
SPLIT = re.compile(r"\s+[-–—]\s+|_-_|\s+-\s*|\s*-\s+")
NOISE = re.compile(r"[\(\[][^)\]]*(official|video|audio|lyric|clip|remaster|hd|hq|visuali[sz]er)[^)\]]*[\)\]]", re.I)
STAMP = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
RETRY_AFTER = 1.5  # seconds before the one retry


def guess(name: str, tags: dict) -> tuple[str, str] | None:
    """(artist, title) from the tags, else from the file name; None if there is no artist to go on."""
    if tags.get("artist") and tags.get("title"):
        return tags["artist"], tags["title"]
    stem = NOISE.sub("", Path(name).stem).replace("_", " ").strip() if "_-_" not in name else Path(name).stem
    parts = SPLIT.split(stem, maxsplit=1)
    if len(parts) != 2:
        return None
    artist, title = (NOISE.sub("", p).replace("_", " ").strip() for p in parts)
    return (artist, title) if artist and title else None


def parse(lrc: str) -> list[list]:
    """LRC text → [[seconds, line], …] sorted; empty lines stay (they clear the screen during instrumentals)."""
    lines = []
    for raw in lrc.splitlines():
        stamps = STAMP.findall(raw)
        text = STAMP.sub("", raw).strip()
        lines += [[round(int(m) * 60 + float(s), 2), text] for m, s in stamps]
    return sorted(lines, key=lambda x: x[0])


def _get(path: str, **params) -> object:
    """One retry: LRCLIB has short outages (503) and the song is playing now, there won't be a second chance."""
    req = urllib.request.Request(f"{API}/{path}?{urllib.parse.urlencode(params)}", headers={"User-Agent": AGENT})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == 2:
                raise
        except OSError:
            if attempt == 2:
                raise
        time.sleep(RETRY_AFTER)


def fetch(artist: str, title: str, duration: int | None) -> list[list] | None:
    """Synced lines for this song, or None. Only real answers are cached: an outage is tried again next time."""
    try:
        return _lookup(artist, title, duration)
    except (OSError, ValueError, KeyError) as exc:
        log.warning("no lyrics for %s – %s: %s", artist, title, exc)
        return None


@lru_cache(maxsize=64)
def _lookup(artist: str, title: str, duration: int | None) -> list[list] | None:
    """The exact match (with the duration) first, then a search."""
    if duration:
        try:
            hit = _get("get", artist_name=artist, track_name=title, duration=duration)
            if hit.get("syncedLyrics"):
                return parse(hit["syncedLyrics"])
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
    found = [h for h in _get("search", artist_name=artist, track_name=title) if h.get("syncedLyrics")] or [
        h for h in _get("search", q=f"{artist} {title}") if h.get("syncedLyrics")]  # looser: "feat.", typos
    if duration:
        found.sort(key=lambda h: abs((h.get("duration") or 0) - duration))
    return parse(found[0]["syncedLyrics"]) if found else None


if __name__ == "__main__":
    assert guess("Kygo_-_Good_For_Me.mp3", {}) == ("Kygo", "Good For Me")
    assert guess("Avicii – Wake Me Up.mp3", {}) == ("Avicii", "Wake Me Up")
    assert guess("Daft Punk - One More Time (Official Video).mp3", {}) == ("Daft Punk", "One More Time")
    assert guess("clip.mp3", {}) is None and guess("x.mp3", {"artist": "A", "title": "B"}) == ("A", "B")
    assert parse("[00:12.50] Hello\n[01:02.00][00:05.00]Again\n[00:20.00]\nno stamp") == [
        [5.0, "Again"], [12.5, "Hello"], [20.0, ""], [62.0, "Again"]]
    calls, real = [], urllib.request.urlopen  # a 503 once: retried, then the answer is cached
    def flaky(req, timeout):
        calls.append(req)
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 503, "busy", None, None)
        return __import__("io").BytesIO(b'{"syncedLyrics": "[00:01.00] Hi"}')
    urllib.request.urlopen, RETRY_AFTER = flaky, 0
    assert fetch("A", "B", 60) == [[1.0, "Hi"]] and fetch("A", "B", 60) == [[1.0, "Hi"]] and len(calls) == 2
    urllib.request.urlopen = real
    print("ok")

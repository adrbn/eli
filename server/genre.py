"""A song's genre, so Eli dresses accordingly (accessory, scene, colour: see web/js/looks.js).

In order: the genre Navidrome gives, the file's tag (ffprobe), then the LLM guessing from the artist
and title ("Kygo – Good For Me" → tropical). Everything ends up as one of LOOKS, or None.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Callable

LOOKS = ("tropical", "electro", "rock", "rap", "jazz", "classique", "country", "chill", "pop")
_RULES = (  # first match wins: "tropical house" is tropical before electro
    ("tropical", r"tropic|reggae|dancehall|calypso|island|bossa|samba|latin|reggaet"),
    ("chill", r"chill|lo-?fi|ambient|downtempo|new age|sleep|acoust"),
    ("electro", r"electr|house|techno|trance|edm|dance|dubstep|drum ?(and|&|n) ?bass|dnb|disco|synth|garage|club"),
    ("rock", r"rock|metal|punk|grunge|hardcore|\bemo\b|indie"),
    ("rap", r"rap|hip.?hop|trap|r ?(&|n) ?b|drill|grime|urban"),
    ("jazz", r"jazz|blues|soul|funk|swing|gospel|motown"),
    ("classique", r"classi|opera|orchestr|baroque|symphon|piano|soundtrack|score"),
    ("country", r"country|folk|bluegrass|americana|western"),
    ("pop", r"pop|chanson|variet|singer|k-?pop"),
)


def normalize(text: str | None) -> str | None:
    """E.g. "Tropical House", "Hip-Hop/Rap", "tropical."… → one of LOOKS."""
    text = (text or "").lower()
    return next((look for look, rule in _RULES if re.search(rule, text)), None)


def tags(path: Path, ffprobe: str | None) -> dict:
    """The file's genre/artist/title tags and duration in s ({} without ffprobe or tags)."""
    if not ffprobe:
        return {}
    try:
        out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration:format_tags", "-of", "json", str(path)],
                             capture_output=True, timeout=10, check=True).stdout
        fmt = json.loads(out).get("format", {})
        found = {k.lower(): v for k, v in fmt.get("tags", {}).items() if k.lower() in ("genre", "artist", "title")}
        return {**found, "duration": round(float(fmt["duration"]))} if fmt.get("duration") else found
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def prompt(name: str) -> list[dict]:
    return [{"role": "system", "content": "You classify songs. Answer with a single word among: "
                                          + ", ".join(LOOKS) + ". If you don't know the song, guess from the "
                                          "artist; otherwise answer pop."},
            {"role": "user", "content": name[:200]}]


def detect(path: Path, name: str, known: str | None, ffprobe: str | None, ask: Callable[[list[dict]], str] | None) -> str | None:
    """The song's look: known genre (Navidrome), else tags, else the LLM (ask), else None."""
    look = normalize(known)
    if look:
        return look
    t = tags(path, ffprobe)
    look = normalize(t.get("genre"))
    if look or not ask:
        return look
    label = " – ".join(v for v in (t.get("artist"), t.get("title")) if v) or Path(name).stem.replace("_", " ")
    try:
        return normalize(ask(prompt(label)))
    except Exception:  # no LLM or it failed: Eli sings without a costume, no big deal
        return None


if __name__ == "__main__":
    assert normalize("Tropical House") == "tropical" and normalize("Hip-Hop/Rap") == "rap"
    assert normalize("Deep House") == "electro" and normalize("Alternative Rock") == "rock"
    assert normalize("tropical.") == "tropical" and normalize("") is None and normalize(None) is None
    assert detect(Path("x.mp3"), "Kygo_-_Good_For_Me.mp3", None, None, lambda m: "Tropical") == "tropical"
    assert detect(Path("x.mp3"), "a.mp3", "Jazz", None, None) == "jazz"
    assert detect(Path("x.mp3"), "a.mp3", None, None, lambda m: 1 / 0) is None
    print("ok")

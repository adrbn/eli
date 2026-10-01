"""English words in a French text: "[en]…[/en]" → raw English phonemes that Piper reads as is."""
from __future__ import annotations

import re
import threading
from functools import lru_cache
from pathlib import Path

TAG = re.compile(r"\[(/?)en\]", re.IGNORECASE)
_lock = threading.Lock()


def segments(text: str) -> list[tuple[bool, str]]:
    """[(english?, chunk), …]. An orphan tag (sentence cut in the middle) is tolerated."""
    out, english, pos = [], False, 0
    for m in TAG.finditer(text):
        if text[pos:m.start()]:
            out.append((english, text[pos:m.start()]))
        english, pos = not m.group(1), m.end()
    if text[pos:]:
        out.append((english, text[pos:]))
    return out


def plain(text: str) -> str:
    """The text without tags: for captions, memory and voices that can't do better."""
    return re.sub(r"\s+", " ", TAG.sub("", text)).strip()


@lru_cache(maxsize=512)
def english_phonemes(words: str) -> str:
    from piper import phonemize_espeak
    import piper

    with _lock:
        ph = phonemize_espeak.EspeakPhonemizer(Path(piper.__file__).parent / "espeak-ng-data")
        return " ".join("".join(s) for s in ph.phonemize("en-us", words))


def to_piper(text: str) -> str:
    parts = []
    for english, chunk in segments(text):
        words = re.sub(r"[\[\]]", "", chunk).strip()
        if english and re.search(r"\w", words):
            lead, tail = chunk[:len(chunk) - len(chunk.lstrip())], chunk[len(chunk.rstrip()):]
            parts.append(f"{lead}[[ {english_phonemes(words)} ]]{tail}")
        else:
            parts.append(chunk.replace("[[", "").replace("]]", ""))
    return "".join(parts)


if __name__ == "__main__":
    assert segments("j'adore [en]Two People[/en] !") == [(False, "j'adore "), (True, "Two People"), (False, " !")]
    assert segments("début [en]Don't Stop") == [(False, "début "), (True, "Don't Stop")]
    assert plain("le titre [en]Thriller[/en], top.") == "le titre Thriller, top."
    out = to_piper("j'écoute [en]Two People[/en] en boucle.")
    assert out.startswith("j'écoute [[ ") and "tˈuː" in out and out.endswith(" ]] en boucle."), out
    print("ok")

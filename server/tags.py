"""Les balises que le LLM glisse dans ses phrases et qui ne se prononcent pas.

[joie] … [tristesse] : l'émotion de la phrase, que le visage joue pendant qu'il la dit.
[musique: Daft Punk Get Lucky] : il lance ce morceau (bibliothèque Navidrome) après sa réponse.
"""
from __future__ import annotations

import re

MOODS = ("joie", "rire", "surprise", "tristesse", "colère", "amour", "malice", "gêne")
_MOOD = re.compile(r"\[\s*(joie|rire|surprise|tristesse|col[eè]re|amour|malice|g[eê]ne)\s*\]", re.I)
_MUSIC = re.compile(r"\[\s*musique\s*:\s*([^\]\n]{1,120})\]", re.I)
_NORM = {"colere": "colère", "gene": "gêne"}

HINT = (
    "Commence chaque phrase qui exprime une émotion par une balise d'humeur, une seule par phrase, parmi : "
    "[joie] [rire] [surprise] [tristesse] [colère] [amour] [malice] [gêne]. Elle ne se prononce pas : ton visage la "
    "joue. Exemple : [joie] Trop bien, raconte ! Pas de balise pour une phrase neutre. "
    "Si on te demande de mettre un morceau ou de la musique, ajoute à la fin [musique: artiste titre] "
    "(ou [musique: artiste] ou [musique: genre]) et annonce-le en une phrase courte."
)


def parse(sentence: str) -> tuple[str, str | None, str | None]:
    """(texte à dire, humeur, morceau demandé)."""
    moods = [_NORM.get(m.lower(), m.lower()) for m in _MOOD.findall(sentence)]
    music = _MUSIC.search(sentence)
    text = _MUSIC.sub("", _MOOD.sub("", sentence))
    return re.sub(r"\s+", " ", text).strip(), (moods[-1] if moods else None), (music.group(1).strip() if music else None)


if __name__ == "__main__":
    assert parse("[joie] Trop bien, raconte !") == ("Trop bien, raconte !", "joie", None)
    assert parse("[Colere] Non mais oh.") == ("Non mais oh.", "colère", None)
    assert parse("C'est parti ! [musique: Daft Punk Get Lucky]") == ("C'est parti !", None, "Daft Punk Get Lucky")
    assert parse("Une phrase neutre.") == ("Une phrase neutre.", None, None)
    assert parse("[en]Hello[/en] toi") == ("[en]Hello[/en] toi", None, None)
    print("ok")

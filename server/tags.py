"""Tags the LLM slips into its sentences, which are not spoken.

[joy] … [sad] ([joie] … [tristesse] in French): the sentence's emotion, which the face plays while saying it.
[music: Daft Punk Get Lucky] ([musique: …]): it plays this song (Navidrome library) after its answer.
Both languages always parse; moods come out as the canonical (French) ids that face.js and X-Mood use.
"""
from __future__ import annotations

import re

MOODS = ("joie", "rire", "surprise", "tristesse", "colère", "amour", "malice", "gêne")
_ALIAS = {"colere": "colère", "gene": "gêne", "joy": "joie", "laugh": "rire", "sad": "tristesse", "angry": "colère",
          "love": "amour", "mischief": "malice", "shy": "gêne"}
_MOOD = re.compile(r"\[\s*(joie|rire|surprise|tristesse|col[eè]re|amour|malice|g[eê]ne"
                   r"|joy|laugh|sad|angry|love|mischief|shy)\s*\]", re.I)
_MUSIC = re.compile(r"\[\s*(?:musique|music)\s*:\s*([^\]\n]{1,120})\]", re.I)

HINT = {
    "fr": (
        "Commence chaque phrase qui exprime une émotion par une balise d'humeur, une seule par phrase, parmi : "
        "[joie] [rire] [surprise] [tristesse] [colère] [amour] [malice] [gêne]. Elle ne se prononce pas : ton visage la "
        "joue. Exemple : [joie] Trop bien, raconte ! Pas de balise pour une phrase neutre. "
        "Si on te demande de mettre un morceau ou de la musique, ajoute à la fin [musique: artiste titre] "
        "(ou [musique: artiste] ou [musique: genre]) et annonce-le en une phrase courte. Mets la balise même si tu ne "
        "connais pas ce morceau ou cette collaboration : c'est sa bibliothèque qui décide, pas ta mémoire. Tu parles "
        "avant la recherche : ne dis jamais que tu ne le trouves pas ou qu'il n'existe pas, annonce juste que tu le "
        "lances (si la bibliothèque ne l'a pas, on le lui dira après). Tu ne sais pas encore quel morceau sortira et "
        "tu l'annonceras toi-même juste avant : dis seulement quelques mots de réaction, à varier à chaque fois (pas "
        "toujours « tout de suite »), sans redire le titre. Pour « un autre dans le même style », « un truc similaire » "
        "ou « pas le même », mets [musique: pareil] : il en choisit un autre proche de celui qui joue."
    ),
    "en": (
        "Start each sentence that expresses an emotion with one mood tag, a single one per sentence, among: "
        "[joy] [laugh] [surprise] [sad] [angry] [love] [mischief] [shy]. It is not spoken: your face plays it. "
        "Example: [joy] That's great, tell me more! No tag for a neutral sentence. "
        "If you're asked to play a song or some music, add [music: artist title] at the end "
        "(or [music: artist] or [music: genre]) and announce it in one short sentence. Add the tag even if you don't "
        "know that song or collaboration: their library decides, not your memory. You speak before the search: never "
        "say you can't find it or that it doesn't exist, just announce you're putting it on (if the library lacks it, "
        "they'll be told afterwards). You don't know yet which song will come out, and you'll name it yourself right "
        "before it starts: just react in a few words, different each time (not always \"right away\"), without "
        "repeating the title. For \"another one like this\", \"something similar\" or \"not the same one\", use "
        "[music: similar]: it picks another one close to the one playing."
    ),
}


def parse(sentence: str) -> tuple[str, str | None, str | None]:
    """(text to say, mood, requested song)."""
    moods = [_ALIAS.get(m.lower(), m.lower()) for m in _MOOD.findall(sentence)]
    music = _MUSIC.search(sentence)
    text = _MUSIC.sub("", _MOOD.sub("", sentence))
    return re.sub(r"\s+", " ", text).strip(), (moods[-1] if moods else None), (music.group(1).strip() if music else None)


if __name__ == "__main__":
    assert parse("[joie] Trop bien, raconte !") == ("Trop bien, raconte !", "joie", None)
    assert parse("[Colere] Non mais oh.") == ("Non mais oh.", "colère", None)
    assert parse("C'est parti ! [musique: Daft Punk Get Lucky]") == ("C'est parti !", None, "Daft Punk Get Lucky")
    assert parse("Une phrase neutre.") == ("Une phrase neutre.", None, None)
    assert parse("[en]Hello[/en] toi") == ("[en]Hello[/en] toi", None, None)
    assert parse("[joy] Great, tell me! [music: Daft Punk]") == ("Great, tell me!", "joie", "Daft Punk")
    assert parse("[Shy] Oh, stop.") == ("Oh, stop.", "gêne", None)
    assert parse("[angry] No way.")[1] == "colère" and parse("[mischief] Hehe.")[1] == "malice"
    assert {_ALIAS.get(m, m) for m in ("joy", "laugh", "surprise", "sad", "angry", "love", "mischief", "shy")} == set(MOODS)
    print("ok")

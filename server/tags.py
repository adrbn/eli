"""Tags the LLM slips into its sentences, which are not spoken.

[joy] … [sad] ([joie] … [tristesse] in French): the sentence's emotion, which the face plays while saying it.
[music: Daft Punk Get Lucky] ([musique: …]): it plays this song (Navidrome library) after its answer.
[sleep] / [sleep: 7:30] / [sleep: +20] ([dodo…]): it falls asleep after its answer; the page picks the wake-up time.
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
_PLACEHOLDER = {"genre", "artiste", "titre", "artiste titre", "artist", "title", "artist title", "…", "..."}
_SLEEP = re.compile(r"\[\s*(?:dodo|sleep)\s*(?::\s*([^\]\n]{0,20}))?\]", re.I)

HINT = {
    "fr": (
        "Commence chaque phrase qui exprime une émotion par une balise d'humeur, une seule par phrase, parmi : "
        "[joie] [rire] [surprise] [tristesse] [colère] [amour] [malice] [gêne]. Elle ne se prononce pas : ton visage la "
        "joue. Exemple : [joie] Trop bien, raconte ! Pas de balise pour une phrase neutre. "
        "Si on te demande de la musique, ajoute à la fin la balise avec ce qu'on t'a demandé, par exemple "
        "[musique: Daft Punk Get Lucky], [musique: Adele] ou [musique: jazz], et réagis en quelques mots, variés, sans redire le titre. C'est sa bibliothèque qui cherche, "
        "pas ta mémoire : ne dis jamais que tu ne le trouves pas. Pour « un autre dans le même style », mets "
        "[musique: pareil]. Si on te dit d'aller dormir (bonne nuit, va te coucher…), souhaite bonne nuit en une "
        "phrase, sans musique sauf si on en demande, et ajoute [dodo] ; avec une heure de réveil, [dodo: 7h30] ; avec un délai, [dodo: +20] (en minutes)."
    ),
    "en": (
        "Start each sentence that expresses an emotion with one mood tag, a single one per sentence, among: "
        "[joy] [laugh] [surprise] [sad] [angry] [love] [mischief] [shy]. It is not spoken: your face plays it. "
        "Example: [joy] That's great, tell me more! No tag for a neutral sentence. "
        "If you're asked for music, add the tag with what was asked at the end, for example "
        "[music: Daft Punk Get Lucky], [music: Adele] or [music: jazz], and react in a few words, different each time, without repeating the title. Their library searches, not your "
        "memory: never say you can't find it. For \"another one like this\", use [music: similar]. If you're told to go "
        "to sleep (good night, go to bed…), say good night in one sentence, no music unless asked, and add [sleep]; with a wake-up time, "
        "[sleep: 7:30]; with a delay, [sleep: +20] (in minutes)."
    ),
}


def parse(sentence: str) -> tuple[str, str | None, str | None]:
    """(text to say, mood, requested song)."""
    moods = [_ALIAS.get(m.lower(), m.lower()) for m in _MOOD.findall(sentence)]
    music = _MUSIC.search(sentence)
    text = _SLEEP.sub("", _MUSIC.sub("", _MOOD.sub("", sentence)))
    song = music.group(1).strip() if music else None
    if song and song.lower() in _PLACEHOLDER:  # it copied the hint's example: no search for « genre »
        song = None
    return re.sub(r"\s+", " ", text).strip(), (moods[-1] if moods else None), song


def sleep_at(sentence: str) -> str | None:
    """[dodo] → "" (the page's default, 8 h at most), [dodo: 7h30] / [dodo: +20] → "7h30" / "+20"; None: no tag."""
    m = _SLEEP.search(sentence)
    return (m.group(1) or "").strip() if m else None


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
    assert parse("Bonne nuit ! [dodo]") == ("Bonne nuit !", None, None)
    assert sleep_at("Bonne nuit ! [dodo]") == "" and sleep_at("[dodo: 7h30]") == "7h30"
    assert sleep_at("Night! [sleep: +20]") == "+20" and sleep_at("Salut.") is None
    assert parse("Une berceuse ! [musique: genre]") == ("Une berceuse !", None, None)
    print("ok")

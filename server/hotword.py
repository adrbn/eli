"""The wake word "Eli", in two stages.

1. Vosk (small offline model for the current language, a few ms) listens to each speech chunk and lets through what
   sounds like "Eli". On its own it is too rough (measured on 5 synthetic French voices: half the "Eli"s missed in free
   dictation, 12% false alarms with a grammar): we take the union of both readings, broadly.
2. The real ears (Parakeet, Whisper) only transcribe those chunks, confirm the name and give the command.
   Everything else said in the room never leaves the machine.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

log = logging.getLogger("eli")

# Common words so the grammar has more than the name to offer (otherwise everything becomes the name).
COMMON_FR = """le la les un une des de du et à au aux en dans sur pour par avec sans ce cette ces il elle ils elles on
je tu nous vous lui leur y me te se moi toi est es suis sont a as ai ont va vas vais vont fait fais dit dis vu vois
peut veut faut lit lis lu être avoir faire aller voir dire venir prendre mettre oui non pas ne plus très bien bon
beau belle joli jolie petit grand tout rien quoi qui que quand comment pourquoi où alors allez viens vient là ici ça
c'est quel quelle heure temps jour soir matin demain nuit lits île îles lycée ville vie vite hélas salut hé merci
maison chat chien ami amie famille monde travail musique chanson film livre journal""".split()
COMMON_EN = """the a an and or but of to in on at for with without from by about as is are was were be been am i you he
she it we they me him her us them my your his its our their this that these those what who when where why how which
there here do does did have has had can could will would should may might must not no yes yeah okay ok hey hi hello oh
please thanks thank go going come came get got make made take see look say said tell told know think want like love
play sing song music time day night today tomorrow morning weather good great nice little big all some any more very
just really so too now then up down out over again well right lovely early alley belly""".split()

# lang → (Vosk model, what Vosk writes when you say "Eli" (noted on the test voices: broad on purpose, stage 2
# decides), the name's spellings in the grammar, the other grammar words). English speakers say "EE-lie", which the
# small model hears as "lie", "ally", "early"…
MODELS = {
    "fr": ("vosk-model-small-fr-0.22", re.compile(r"\b(éli|eli|elie|élie|ellie|elli|elly|ely|hélie|kelly|lily)\b"),
           ("éli",), COMMON_FR),
    "en": ("vosk-model-small-en-us-0.15",
           re.compile(r"\b(eli|ellie|elly|ely|elie|lie|lee|ally|alley|lily|early|elite|elin|line|light)\b"),
           ("eli", "ellie"), COMMON_EN),
}

# Stage 2, on the real ears' transcription: the name within the first words, then the command. Both languages.
NAME = re.compile(r"^\W*(?:(?:hé|hey|eh|dis|di|ok|okay|salut|coucou|bonjour|allô|hi|hello|yo|oh|say)\W+){0,2}"
                  r"(?:éli|eli|élie|elie|ellie|elli|elly|ely|hélie|ély)\b[\s,.!?…:;-]*(.*)$", re.I | re.S)


def command(text: str) -> str | None:
    """The command that follows "Eli" ("" if only the name was said), or None if the name isn't there."""
    m = NAME.match(text.strip())
    return m.group(1).strip() if m else None


class Hotword:
    def __init__(self, folder: Path, lang: Callable[[], str] = lambda: "fr"):
        self.folder, self.lang, self.lock, self.recs = folder, lang, threading.Lock(), {}

    def _load(self, name: str):
        from vosk import Model, SetLogLevel  # imported here: the server starts without Vosk if you don't want it
        SetLogLevel(-1)
        path = self.folder / name
        if not path.exists():
            log.info("downloading the wake-word model %s (~40 MB)…", name)
            tmp = path.with_suffix(".zip.part")
            urllib.request.urlretrieve(f"https://alphacephei.com/vosk/models/{name}.zip", tmp)
            with zipfile.ZipFile(tmp) as z:
                z.extractall(path.parent)
            tmp.unlink()
        return Model(str(path))

    def maybe(self, pcm: bytes) -> bool:
        """Stage 1. pcm: 16-bit mono 16 kHz."""
        from vosk import KaldiRecognizer
        lang = self.lang()
        name, heard, names, common = MODELS[lang]
        with self.lock:  # both readers are kept (the grammar takes ~0.7 s to compile); one chunk at a time
            if lang not in self.recs:
                model = self._load(name)
                grammar = json.dumps(sorted(set(common) - set(names)) + list(names) + ["[unk]"], ensure_ascii=False)
                self.recs[lang] = KaldiRecognizer(model, 16000), KaldiRecognizer(model, 16000, grammar)
            texts = []
            for rec in self.recs[lang]:
                rec.AcceptWaveform(pcm)
                texts.append(json.loads(rec.FinalResult()).get("text", ""))  # FinalResult resets the reader
        return bool(heard.search(texts[0])) or bool(set(names) & set(texts[1].split()))


if __name__ == "__main__":
    assert command("Eli, quelle heure est-il ?") == "quelle heure est-il ?"
    assert command("Hé Élie !") == ""
    assert command("dis Ely tu chantes") == "tu chantes"
    assert command("Di Elie, tu chantes.") == "tu chantes."
    assert command("Il y a du monde.") is None
    assert command("Élisabeth arrive") is None
    assert command("Tu as vu Eli ?") is None  # talking about him, not to him
    assert command("Hey Eli, what time is it?") == "what time is it?"
    assert command("Eli, sing me a song.") == "sing me a song."
    assert command("Hi Ellie!") == ""
    assert command("Okay Eli play some jazz") == "play some jazz"
    assert command("Did you see Eli?") is None
    assert command("Elijah is here.") is None
    assert MODELS["fr"][2] == ("éli",) and all(MODELS[k][1].search(n) for k in MODELS for n in MODELS[k][2])
    print("ok")

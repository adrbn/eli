"""Le mot de réveil « Eli », en deux étages.

1. Vosk (petit modèle français, hors ligne, quelques ms) écoute chaque bout de phrase et laisse passer ce qui
   ressemble à « Eli ». Seul, il est trop approximatif (mesuré sur 5 voix de synthèse : la moitié des « Eli »
   ratés en dictée libre, 12 % de fausses alertes avec une grammaire) : on prend l'union des deux lectures, large.
2. Les vraies oreilles (Parakeet, Whisper) ne transcrivent que ces bouts-là, confirment le nom et donnent la
   commande. Le reste de ce qui se dit dans la pièce ne sort jamais de la machine.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import urllib.request
import zipfile
from pathlib import Path

log = logging.getLogger("eli")

MODEL = "vosk-model-small-fr-0.22"
URL = f"https://alphacephei.com/vosk/models/{MODEL}.zip"

# Ce que Vosk écrit quand on dit « Eli » (relevé sur les voix de test) : large exprès, l'étage 2 tranche.
HEARD = re.compile(r"\b(éli|eli|elie|élie|ellie|elli|elly|ely|hélie|kelly|lily)\b")
# Des mots courants pour que la grammaire ait autre chose que « éli » à proposer (sinon tout devient « éli »).
COMMON = """le la les un une des de du et à au aux en dans sur pour par avec sans ce cette ces il elle ils elles on
je tu nous vous lui leur y me te se moi toi est es suis sont a as ai ont va vas vais vont fait fais dit dis vu vois
peut veut faut lit lis lu être avoir faire aller voir dire venir prendre mettre oui non pas ne plus très bien bon
beau belle joli jolie petit grand tout rien quoi qui que quand comment pourquoi où alors allez viens vient là ici ça
c'est quel quelle heure temps jour soir matin demain nuit lits île îles lycée ville vie vite hélas salut hé merci
maison chat chien ami amie famille monde travail musique chanson film livre journal""".split()
GRAMMAR = json.dumps(sorted(set(COMMON)) + ["éli", "[unk]"], ensure_ascii=False)

# Étage 2, sur la transcription des vraies oreilles : le nom dans les premiers mots, puis la commande.
NAME = re.compile(r"^\W*(?:(?:hé|hey|eh|dis|di|ok|okay|salut|coucou|bonjour|allô)\W+){0,2}"
                  r"(?:éli|eli|élie|elie|ellie|elli|elly|ely|hélie|ély)\b[\s,.!?…:;-]*(.*)$", re.I | re.S)


def command(text: str) -> str | None:
    """La commande qui suit « Eli » ("" s'il n'a dit que son nom), ou None si le nom n'y est pas."""
    m = NAME.match(text.strip())
    return m.group(1).strip() if m else None


class Hotword:
    def __init__(self, folder: Path):
        self.path, self.lock, self.recs = folder / MODEL, threading.Lock(), None

    def _load(self):
        from vosk import Model, SetLogLevel  # importé ici : le serveur démarre sans Vosk si on n'en veut pas
        SetLogLevel(-1)
        if not self.path.exists():
            log.info("téléchargement du modèle de réveil %s (42 Mo)…", MODEL)
            tmp = self.path.with_suffix(".zip.part")
            urllib.request.urlretrieve(URL, tmp)
            with zipfile.ZipFile(tmp) as z:
                z.extractall(self.path.parent)
            tmp.unlink()
        return Model(str(self.path))

    def maybe(self, pcm: bytes) -> bool:
        """Étage 1. pcm : 16 bits mono 16 kHz."""
        from vosk import KaldiRecognizer
        with self.lock:  # les deux lecteurs sont gardés (la grammaire coûte ~0,7 s à compiler) ; un bout à la fois
            if self.recs is None:
                model = self._load()
                self.recs = KaldiRecognizer(model, 16000), KaldiRecognizer(model, 16000, GRAMMAR)
            texts = []
            for rec in self.recs:
                rec.AcceptWaveform(pcm)
                texts.append(json.loads(rec.FinalResult()).get("text", ""))  # FinalResult remet le lecteur à zéro
        return bool(HEARD.search(texts[0])) or "éli" in texts[1].split()


if __name__ == "__main__":
    assert command("Eli, quelle heure est-il ?") == "quelle heure est-il ?"
    assert command("Hé Élie !") == ""
    assert command("dis Ely tu chantes") == "tu chantes"
    assert command("Di Elie, tu chantes.") == "tu chantes."
    assert command("Il y a du monde.") is None
    assert command("Élisabeth arrive") is None
    assert command("Tu as vu Eli ?") is None  # on parle de lui, pas à lui
    print("ok")

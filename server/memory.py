"""La mémoire d'Eli : la conversation en cours survit aux redémarrages, et un carnet de souvenirs durables.

Après ~90 s de silence, les nouveaux échanges sont « digérés » par le LLM : il met à jour le carnet
(memory/souvenirs.md, un fait par ligne, lisible et modifiable à la main). Le carnet et la date du jour
entrent dans chaque demande au LLM : Eli se souvient d'un jour à l'autre sans relire toute l'histoire.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("eli.memory")

HISTORY_MESSAGES = 16  # ce que le LLM relit mot pour mot ; le reste passe par le carnet
MAX_NOTES = 80
DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]

DIGEST_PROMPT = (
    "Tu tiens le carnet de souvenirs d'Eli, le petit compagnon robot de son humain. On te donne le carnet actuel "
    "et de nouveaux échanges entre eux. Rends le carnet mis à jour : seulement des faits durables, utiles plus "
    "tard (qui est son humain : son prénom, ses proches, ses goûts, ses projets, ses décisions, ce qu'il a demandé de retenir, "
    "les événements avec leur date). Ajoute, corrige ou retire ; fusionne les doublons ; aucun bavardage. "
    f"Une ligne par fait, qui commence par « - ». {MAX_NOTES} lignes au plus. "
    "Si rien de nouveau ne mérite d'être retenu, rends le carnet tel quel. Réponds uniquement par le carnet."
)


def today(now: float | None = None) -> str:
    t = time.localtime(now)
    return f"{DAYS[t.tm_wday]} {t.tm_mday} {MONTHS[t.tm_mon - 1]} {t.tm_year}, {t.tm_hour} h {t.tm_min:02d}"


class Memory:
    def __init__(self, folder: Path | None, digest: Callable[[list[dict]], str] | None = None, idle: float = 90):
        """folder None : rien n'est écrit sur disque (tests). digest(messages) → texte du LLM."""
        self.folder, self.digest, self.idle = folder, digest, idle
        self.lock = threading.Lock()
        self.timer: threading.Timer | None = None
        self.history: list[dict] = []
        self.pending: list[dict] = []  # échanges pas encore passés au carnet
        if folder:
            folder.mkdir(parents=True, exist_ok=True)
            try:
                data = json.loads((folder / "conversation.json").read_text("utf-8"))
                self.history, self.pending = data.get("history", []), data.get("pending", [])
            except (FileNotFoundError, ValueError):
                pass
            if self.pending:
                self._schedule(10)  # des échanges d'avant l'arrêt attendent encore d'être retenus

    # --- lecture -------------------------------------------------------------------------------
    def notes(self) -> str:
        try:
            return (self.folder / "souvenirs.md").read_text("utf-8").strip() if self.folder else ""
        except FileNotFoundError:
            return ""

    def system_prompt(self, persona: str) -> str:
        parts = [persona, f"Nous sommes le {today()}."]
        notes = self.notes()
        if notes:
            parts.append("Ce que tu sais de ton humain, de tes conversations passées (sers-t'en naturellement, "
                         "sans le réciter) :\n" + notes)
        return "\n\n".join(parts)

    def recent(self) -> list[dict]:
        with self.lock:
            return list(self.history[-HISTORY_MESSAGES:])

    # --- écriture ------------------------------------------------------------------------------
    def add(self, user: str, reply: str) -> None:
        exchange = [{"role": "user", "content": user}, {"role": "assistant", "content": reply}]
        with self.lock:
            self.history = (self.history + exchange)[-HISTORY_MESSAGES:]
            self.pending = self.pending + exchange
            self._save()
        self._schedule(self.idle)

    def forget(self, everything: bool = False) -> None:
        """La conversation en cours ; avec everything, le carnet aussi."""
        with self.lock:
            self.history, self.pending = [], []
            self._save()
            if everything and self.folder:
                (self.folder / "souvenirs.md").unlink(missing_ok=True)

    def consolidate(self) -> None:
        with self.lock:
            taken = list(self.pending)
        if not taken or not self.digest or not self.folder:
            return
        transcript = "\n".join(f"{'Humain' if m['role'] == 'user' else 'Eli'} : {m['content']}" for m in taken)
        try:
            text = self.digest([
                {"role": "system", "content": DIGEST_PROMPT},
                {"role": "user", "content": f"Date : {today()}\n\nCarnet actuel :\n{self.notes() or '(vide)'}"
                                            f"\n\nNouveaux échanges :\n{transcript}"},
            ])
        except Exception as exc:  # réseau, quota… on réessaiera au prochain silence
            log.warning("carnet de souvenirs pas mis à jour : %s", exc)
            return
        lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("- ")][:MAX_NOTES]
        with self.lock:
            if self.pending[: len(taken)] != taken:  # « Tout oublier » est passé entre-temps
                return
            if lines or not self.notes():  # une réponse vide ou hors format n'efface jamais le carnet
                (self.folder / "souvenirs.md").write_text("\n".join(lines) + "\n", "utf-8")
            self.pending = self.pending[len(taken):]
            self._save()
        log.info("carnet de souvenirs : %d faits", len(lines))

    def _schedule(self, delay: float) -> None:
        if self.timer:
            self.timer.cancel()
        self.timer = threading.Timer(delay, self.consolidate)
        self.timer.daemon = True
        self.timer.start()

    def _save(self) -> None:
        if self.folder:
            tmp = self.folder / "conversation.json.part"
            tmp.write_text(json.dumps({"history": self.history, "pending": self.pending}, ensure_ascii=False), "utf-8")
            tmp.replace(self.folder / "conversation.json")

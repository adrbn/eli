"""Eli's memory: the ongoing conversation survives restarts, plus a notebook of lasting memories.

After ~90 s of silence, new exchanges are "digested" by the LLM: it updates the notebook
(memory/souvenirs.md, one fact per line, readable and editable by hand). The notebook and today's date
go into every LLM request: Eli remembers from one day to the next without rereading the whole history.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("eli.memory")

HISTORY_MESSAGES = 16  # what the LLM rereads word for word; the rest goes through the notebook
MAX_NOTES = 80
DAYS = {"fr": ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
        "en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]}
MONTHS = {"fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
                 "novembre", "décembre"],
          "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
                 "November", "December"]}

DIGEST_PROMPT = {
    "fr": (
        "Tu tiens le carnet de souvenirs d'Eli, le petit compagnon robot de son humain. On te donne le carnet actuel "
        "et de nouveaux échanges entre eux. Rends le carnet mis à jour : seulement des faits durables, utiles plus "
        "tard (qui est son humain : son prénom, ses proches, ses goûts, ses projets, ses décisions, ce qu'il a demandé "
        "de retenir, les événements avec leur date). Ajoute, corrige ou retire ; fusionne les doublons ; aucun "
        f"bavardage. Une ligne par fait, qui commence par « - ». {MAX_NOTES} lignes au plus. "
        "Si rien de nouveau ne mérite d'être retenu, rends le carnet tel quel. Réponds uniquement par le carnet."
    ),
    "en": (
        "You keep the memory notebook of Eli, its human's little robot companion. You're given the current notebook "
        "and new exchanges between them. Return the updated notebook: only lasting facts, useful later (who its "
        "human is: their name, their close ones, their tastes, their plans, their decisions, what they asked to "
        "remember, events with their date). Add, fix or remove; merge duplicates; no chit-chat. "
        f"One line per fact, starting with \"- \". {MAX_NOTES} lines at most. "
        "If nothing new is worth remembering, return the notebook as is. Answer with the notebook only."
    ),
}
WORDS = {
    "fr": {"today": "Nous sommes le {}.", "human": "Humain :", "eli": "Eli :", "date": "Date :",
           "notebook": "Carnet actuel :", "empty": "(vide)", "new": "Nouveaux échanges :",
           "notes": "Ce que tu sais de ton humain, de tes conversations passées (sers-t'en naturellement, "
                    "sans le réciter) :\n"},
    "en": {"today": "Today is {}.", "human": "Human:", "eli": "Eli:", "date": "Date:",
           "notebook": "Current notebook:", "empty": "(empty)", "new": "New exchanges:",
           "notes": "What you know about your human, from your past conversations (use it naturally, "
                    "without reciting it):\n"},
}


def today(now: float | None = None, lang: str = "fr") -> str:
    t = time.localtime(now)
    if lang == "en":
        return f"{DAYS['en'][t.tm_wday]}, {MONTHS['en'][t.tm_mon - 1]} {t.tm_mday}, {t.tm_year}, {t.tm_hour}:{t.tm_min:02d}"
    return f"{DAYS['fr'][t.tm_wday]} {t.tm_mday} {MONTHS['fr'][t.tm_mon - 1]} {t.tm_year}, {t.tm_hour} h {t.tm_min:02d}"


class Memory:
    def __init__(self, folder: Path | None, digest: Callable[[list[dict]], str] | None = None, idle: float = 90,
                 lang: Callable[[], str] = lambda: "fr"):
        """folder None: nothing is written to disk (tests). digest(messages) → the LLM's text."""
        self.folder, self.digest, self.idle, self.lang = folder, digest, idle, lang
        self.lock = threading.Lock()
        self.timer: threading.Timer | None = None
        self.history: list[dict] = []
        self.pending: list[dict] = []  # exchanges not yet written to the notebook
        if folder:
            folder.mkdir(parents=True, exist_ok=True)
            try:
                data = json.loads((folder / "conversation.json").read_text("utf-8"))
                self.history, self.pending = data.get("history", []), data.get("pending", [])
            except (FileNotFoundError, ValueError):
                pass
            if self.pending:
                self._schedule(10)  # exchanges from before the shutdown are still waiting to be remembered

    # --- reading -------------------------------------------------------------------------------
    def notes(self) -> str:
        try:
            return (self.folder / "souvenirs.md").read_text("utf-8").strip() if self.folder else ""
        except FileNotFoundError:
            return ""

    def system_prompt(self, persona: str) -> str:
        lang = self.lang()
        parts = [persona, WORDS[lang]["today"].format(today(lang=lang))]
        notes = self.notes()
        if notes:
            parts.append(WORDS[lang]["notes"] + notes)
        return "\n\n".join(parts)

    def recent(self) -> list[dict]:
        with self.lock:
            return list(self.history[-HISTORY_MESSAGES:])

    # --- writing -------------------------------------------------------------------------------
    def add(self, user: str, reply: str) -> None:
        exchange = [{"role": "user", "content": user}, {"role": "assistant", "content": reply}]
        with self.lock:
            self.history = (self.history + exchange)[-HISTORY_MESSAGES:]
            self.pending = self.pending + exchange
            self._save()
        self._schedule(self.idle)

    def forget(self, everything: bool = False) -> None:
        """The ongoing conversation; with everything, the notebook too."""
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
        lang = self.lang()
        w = WORDS[lang]
        transcript = "\n".join(f"{w['human' if m['role'] == 'user' else 'eli']} {m['content']}" for m in taken)
        try:
            text = self.digest([
                {"role": "system", "content": DIGEST_PROMPT[lang]},
                {"role": "user", "content": f"{w['date']} {today(lang=lang)}\n\n{w['notebook']}\n"
                                            f"{self.notes() or w['empty']}\n\n{w['new']}\n{transcript}"},
            ])
        except Exception as exc:  # network, quota… we'll retry at the next silence
            log.warning("memory notebook not updated: %s", exc)
            return
        lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("- ")][:MAX_NOTES]
        with self.lock:
            if self.pending[: len(taken)] != taken:  # "Forget everything" happened meanwhile
                return
            if lines or not self.notes():  # an empty or malformed answer never wipes the notebook
                (self.folder / "souvenirs.md").write_text("\n".join(lines) + "\n", "utf-8")
            self.pending = self.pending[len(taken):]
            self._save()
        log.info("memory notebook: %d facts", len(lines))

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

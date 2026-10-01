"""Developer mode: the last server log lines, kept in memory and stripped of secrets, for the page's log drawer
and the diagnostic report users paste into GitHub issues."""
from __future__ import annotations

import collections
import logging
import re
import subprocess
import threading
import time
from pathlib import Path

SECRET = re.compile(r"(gsk_|sk-|xai-)[\w-]{8,}|(Bearer\s+)\S+|((?:password|passwd|token|secret|api_?key|[?&][pts])=)[^\s&\"']+", re.I)


def redact(text: str) -> str:
    return SECRET.sub(lambda m: (m.group(2) or m.group(3) or "") + "•••", text)


def version(root: Path) -> str:
    """The commit this server runs (with a + if the code was changed since), or "unknown" (no git, Docker…)."""
    try:
        sha = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                             timeout=3, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"],
                               capture_output=True, text=True, timeout=3).stdout.strip()
        return sha + ("+" if dirty else "")
    except (OSError, subprocess.SubprocessError):
        return "unknown"


class Ring(logging.Handler):
    """The last `size` log records, numbered so the page can ask only for the new ones."""

    def __init__(self, size: int = 400):
        super().__init__(logging.INFO)
        self.lines: collections.deque = collections.deque(maxlen=size)
        self.n = 0
        self.mu = threading.Lock()  # not self.lock: Handler already uses that one around emit()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = redact(record.getMessage())
        except Exception:  # a malformed log call must not break logging
            msg = str(record.msg)
        if record.exc_info:
            msg += " · " + redact(repr(record.exc_info[1]))
        with self.mu:
            self.n += 1
            self.lines.append({"n": self.n, "t": round(record.created, 3), "level": record.levelname,
                               "name": record.name, "msg": msg[:2000]})

    def after(self, n: int) -> list[dict]:
        with self.mu:
            return [line for line in self.lines if line["n"] > n]


if __name__ == "__main__":
    assert redact("key gsk_abcdefghijkl1234 ok") == "key ••• ok"
    assert redact("Authorization: Bearer abc.def") == "Authorization: Bearer •••"
    assert redact("GET /rest/ping?u=me&t=abc123&s=salt") == "GET /rest/ping?u=me&t=•••&s=•••"
    assert redact("password=hunter2 x") == "password=••• x"
    ring = Ring(3)
    log = logging.getLogger("t")
    log.addHandler(ring)
    log.setLevel(logging.INFO)
    for i in range(5):
        log.info("line %d", i)
    assert [x["msg"] for x in ring.after(0)] == ["line 2", "line 3", "line 4"] and len(ring.after(4)) == 1
    assert time.time() - ring.after(0)[0]["t"] < 5
    print("ok")

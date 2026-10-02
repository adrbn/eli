"""The Groq key, typed in Settings (the Mac app has no .env to edit): checked with Groq, then kept in the .env.

The key never goes back to the page: the page only learns whether Eli has a brain (GET /api/status, "llm").
"""
from __future__ import annotations

import os
import json
import re
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

GROQ_KEY = re.compile(r"^gsk_[A-Za-z0-9]{20,120}$")  # also keeps newlines and "=" out of the .env


class BadKey(ValueError):
    """A message ready to show."""


def check_groq(key: str, timeout: float = 8) -> None:
    """Raises BadKey unless Groq accepts this key."""
    if not GROQ_KEY.fullmatch(key):
        raise BadKey("not a Groq key (gsk_…)")
    request = urllib.request.Request("https://api.groq.com/openai/v1/models",
                                     headers={"Authorization": f"Bearer {key}", "User-Agent": "eli/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout):
            return
    except urllib.error.HTTPError as exc:
        raise BadKey("Groq refused this key" if exc.code in (401, 403) else f"Groq answered {exc.code}") from exc
    except OSError as exc:
        raise BadKey(f"Groq unreachable ({getattr(exc, 'reason', exc)})") from exc


ENV_VALUE = re.compile(r"^[^\s=#'\"]{0,300}$")  # one .env line: no newline, no quote, no comment


def check_llm(url: str, key: str = "", timeout: float = 8) -> list[str]:
    """A local LLM speaking the OpenAI API (Ollama, LM Studio, mlx_lm.server, llama.cpp…): its models, or BadKey."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not ENV_VALUE.fullmatch(url):
        raise BadKey("invalid address: http(s)://host:port/v1")
    if not ENV_VALUE.fullmatch(key):
        raise BadKey("invalid key")
    headers = {"User-Agent": "eli/0.1", **({"Authorization": f"Bearer {key}"} if key else {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url.rstrip("/") + "/models", headers=headers), timeout=timeout) as r:
            body = json.loads(r.read(1024 * 1024))
    except urllib.error.HTTPError as exc:
        raise BadKey("key refused" if exc.code in (401, 403) else f"the server answered {exc.code} on /models") from exc
    except (OSError, ValueError) as exc:
        raise BadKey(f"unreachable ({getattr(exc, 'reason', exc)}): is it running, and does the address end in /v1?") from exc
    models = [m.get("id") for m in body.get("data", []) if isinstance(m, dict)] if isinstance(body, dict) else []
    return [m for m in models if isinstance(m, str) and ENV_VALUE.fullmatch(m)]


def save(env_file: Path, name: str, value: str) -> None:
    """Sets name=value in the .env (other lines kept), readable by this user only."""
    lines = env_file.read_text("utf-8").splitlines() if env_file.is_file() else []
    kept = [line for line in lines if line.partition("=")[0].strip() != name]
    env_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join([*kept, f"{name}={value}"]) + "\n")
    env_file.chmod(0o600)  # an older .env may have been created wider


if __name__ == "__main__":
    import tempfile
    for bad in ("", "sk-abc", "gsk_short", "gsk_" + "a" * 30 + "\nLLM_URL=http://evil", "gsk_" + "a" * 30 + "="):
        try:
            check_groq(bad)
            raise AssertionError(bad)
        except BadKey:
            pass
    with tempfile.TemporaryDirectory() as tmp:
        env = Path(tmp) / "sub" / ".env"
        save(env, "GROQ_API_KEY", "gsk_one")
        env.write_text(env.read_text() + "PORT=5280\n")
        save(env, "GROQ_API_KEY", "gsk_two")
        assert env.read_text() == "PORT=5280\nGROQ_API_KEY=gsk_two\n", env.read_text()
        assert env.stat().st_mode & 0o777 == 0o600
    for url in ("ftp://x", "localhost:11434", "http://x/v1\nGROQ_API_KEY=x", "http://x/'v1"):
        try:
            check_llm(url)
            raise AssertionError(url)
        except BadKey:
            pass
    print("ok")

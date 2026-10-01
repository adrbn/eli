"""Isolates a song's voice (MDX-Net, see mdx.py), so the face really sings along the vocal track.

The voice comes block by block, faster than playback: each finished block is announced, the page reloads the
partial voice (silence where it isn't computed yet) and sings as soon as it has it.
One song at a time; a new song cuts the previous one, and its separation too.
The result is cached by file hash: a song already seen sings right away.
"""
from __future__ import annotations

import io
import logging
import os
import queue
import threading
import wave
from pathlib import Path
from typing import Callable

import numpy as np

from mdx import OUT_SR, SR, decode

log = logging.getLogger("eli.stems")


def wav_bytes(pcm: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(OUT_SR)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


class Stems:
    def __init__(self, separator, ffmpeg: str, folder: Path, on_ready: Callable[[str, str, str | None], None],
                 on_progress: Callable[[list[str], str, int, int], None] = lambda ids, sha, done, total: None):
        self.separator, self.ffmpeg, self.folder = separator, ffmpeg, folder
        self.on_ready, self.on_progress = on_ready, on_progress
        folder.mkdir(parents=True, exist_ok=True)
        self.jobs: queue.Queue = queue.Queue()
        self.waiting: dict[str, list[str]] = {}
        self.partial: dict[str, np.ndarray] = {}  # voices being computed, int16 mono 16 kHz
        self.lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True).start()

    def path(self, sha: str) -> Path:
        return self.folder / f"{sha}.wav"

    def audio(self, sha: str) -> bytes | None:
        """The isolated voice as WAV: complete if cached, otherwise what has been computed so far."""
        with self.lock:
            pcm = self.partial.get(sha)
            if pcm is not None:
                return wav_bytes(pcm)
        try:
            return self.path(sha).read_bytes()
        except FileNotFoundError:
            return None

    def request(self, src: Path, sha: str, clip_id: str) -> bool:
        """Asks for the isolated voice; True if it is already ready (on_ready is then called right away)."""
        try:
            os.utime(self.path(sha))  # already isolated; touching it keeps it safe from cache cleanup
        except FileNotFoundError:
            pass
        else:
            self.on_ready(clip_id, sha, None)
            return True
        with self.lock:
            if sha in self.waiting:
                self.waiting[sha].append(clip_id)
                return False
            self.waiting.clear()  # earlier songs were cut: their voice would be useless
            self.waiting[sha] = [clip_id]
        self.jobs.put((src, sha))
        return False

    def _worker(self) -> None:
        while True:
            src, sha = self.jobs.get()
            error = None
            try:
                self._separate(src, sha)
            except Exception as exc:
                log.exception("separation failed on %s", src.name)
                error = str(exc)[:300]
            with self.lock:
                self.partial.pop(sha, None)
                ids = self.waiting.pop(sha, None)
            for clip_id in ids or []:  # None: dropped for another song, nobody is waiting any more
                self.on_ready(clip_id, sha, error)

    def _separate(self, src: Path, sha: str) -> None:
        mix = decode(self.ffmpeg, src)
        pcm = np.zeros(int(mix.shape[1] * OUT_SR / SR), dtype=np.int16)
        with self.lock:
            if sha not in self.waiting:
                return
            self.partial[sha] = pcm
        log.info("voice: separating %s (%.0f s)…", src.name, mix.shape[1] / SR)
        at = 0
        for k, total, vocal in self.separator.blocks(mix):
            chunk = (np.clip(vocal, -1, 1) * 32767).astype(np.int16)[: len(pcm) - at]
            with self.lock:
                if sha not in self.waiting:
                    log.info("voice: %s dropped, another song replaced it", src.name)
                    return
                pcm[at: at + len(chunk)] = chunk
                ids = list(self.waiting[sha])
            at += len(chunk)
            if k + 1 < total:
                self.on_progress(ids, sha, k + 1, total)
        tmp = self.path(sha).with_suffix(".part")
        tmp.write_bytes(wav_bytes(pcm))
        tmp.replace(self.path(sha))
        log.info("voice: isolated for %s", src.name)

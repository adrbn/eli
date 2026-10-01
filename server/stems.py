"""Isole la voix d'un morceau (MDX-Net, voir mdx.py), pour que le visage chante en vrai sur la piste vocale.

La voix arrive bloc par bloc, plus vite que la lecture : chaque bloc fini est annoncé, la page recharge la
voix partielle (silence là où elle n'est pas encore calculée) et chante dès qu'elle la tient.
Un seul morceau à la fois ; un nouveau morceau coupe le précédent, et sa séparation avec.
Le résultat est mis en cache par empreinte du fichier : un morceau déjà vu chante tout de suite.
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
        self.partial: dict[str, np.ndarray] = {}  # voix en cours de calcul, int16 mono 16 kHz
        self.lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True).start()

    def path(self, sha: str) -> Path:
        return self.folder / f"{sha}.wav"

    def audio(self, sha: str) -> bytes | None:
        """La voix isolée en WAV : complète si elle est en cache, sinon ce qui en est déjà calculé."""
        with self.lock:
            pcm = self.partial.get(sha)
            if pcm is not None:
                return wav_bytes(pcm)
        try:
            return self.path(sha).read_bytes()
        except FileNotFoundError:
            return None

    def request(self, src: Path, sha: str, clip_id: str) -> bool:
        """Demande la voix isolée ; True si elle est déjà prête (on_ready est alors appelé tout de suite)."""
        try:
            os.utime(self.path(sha))  # déjà isolée ; la rajeunir la garde à l'abri du ménage du cache
        except FileNotFoundError:
            pass
        else:
            self.on_ready(clip_id, sha, None)
            return True
        with self.lock:
            if sha in self.waiting:
                self.waiting[sha].append(clip_id)
                return False
            self.waiting.clear()  # les morceaux d'avant ont été coupés : leur voix ne servirait plus
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
                log.exception("séparation en échec sur %s", src.name)
                error = str(exc)[:300]
            with self.lock:
                self.partial.pop(sha, None)
                ids = self.waiting.pop(sha, None)
            for clip_id in ids or []:  # None : abandonné pour un autre morceau, plus personne n'attend
                self.on_ready(clip_id, sha, error)

    def _separate(self, src: Path, sha: str) -> None:
        mix = decode(self.ffmpeg, src)
        pcm = np.zeros(int(mix.shape[1] * OUT_SR / SR), dtype=np.int16)
        with self.lock:
            if sha not in self.waiting:
                return
            self.partial[sha] = pcm
        log.info("voix : séparation de %s (%.0f s)…", src.name, mix.shape[1] / SR)
        at = 0
        for k, total, vocal in self.separator.blocks(mix):
            chunk = (np.clip(vocal, -1, 1) * 32767).astype(np.int16)[: len(pcm) - at]
            with self.lock:
                if sha not in self.waiting:
                    log.info("voix : %s abandonné, un autre morceau l'a remplacé", src.name)
                    return
                pcm[at: at + len(chunk)] = chunk
                ids = list(self.waiting[sha])
            at += len(chunk)
            if k + 1 < total:
                self.on_progress(ids, sha, k + 1, total)
        tmp = self.path(sha).with_suffix(".part")
        tmp.write_bytes(wav_bytes(pcm))
        tmp.replace(self.path(sha))
        log.info("voix : isolée pour %s", src.name)

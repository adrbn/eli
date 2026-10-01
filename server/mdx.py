"""Voice isolated by MDX-Net (UVR model Kim_Vocal_2, ONNX): ~1.8× real time on this Mac, block by block.

Each block is 5.75 s long and takes ~3 s to compute: processed in order, the voice runs ahead of playback
from the first block, and the face sings from the very first listen.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterator

import numpy as np

SR = 44100
N_FFT, HOP, DIM_F, DIM_T = 7680, 1024, 3072, 256  # Kim_Vocal_2 training parameters
CHUNK = HOP * (DIM_T - 1)
TRIM = N_FFT // 2
BLOCK = CHUNK - 2 * TRIM  # useful samples per block (5.75 s)
WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)  # periodic Hann
OUT_SR = 16000  # what the mouth analysis consumes


def decode(ffmpeg: str, src: Path) -> np.ndarray:
    """The whole file as float32 stereo at 44.1 kHz, shape (2, n)."""
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(src), "-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True, timeout=120,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def stft(x: np.ndarray) -> np.ndarray:
    """(2, CHUNK) → model input (1, 4, DIM_F, DIM_T): re/im of each channel, like torch.stft(center=True)."""
    padded = np.pad(x, ((0, 0), (N_FFT // 2, N_FFT // 2)), mode="reflect")
    idx = np.arange(DIM_T)[:, None] * HOP + np.arange(N_FFT)[None, :]
    spec = np.fft.rfft(padded[:, idx] * WINDOW, axis=-1)[:, :, :DIM_F].transpose(0, 2, 1)  # (2, F, T)
    return np.stack([spec[0].real, spec[0].imag, spec[1].real, spec[1].imag])[None].astype(np.float32)


def istft(y: np.ndarray) -> np.ndarray:
    """Model output (1, 4, DIM_F, DIM_T) → (2, CHUNK), inverse of stft()."""
    spec = np.zeros((2, N_FFT // 2 + 1, DIM_T), dtype=np.complex64)
    spec[0, :DIM_F] = y[0, 0] + 1j * y[0, 1]
    spec[1, :DIM_F] = y[0, 2] + 1j * y[0, 3]
    frames = np.fft.irfft(spec.transpose(0, 2, 1), n=N_FFT, axis=-1) * WINDOW  # (2, T, N_FFT)
    out = np.zeros((2, CHUNK + N_FFT), dtype=np.float32)
    norm = np.zeros(CHUNK + N_FFT, dtype=np.float32)
    for t in range(DIM_T):
        out[:, t * HOP: t * HOP + N_FFT] += frames[:, t]
        norm[t * HOP: t * HOP + N_FFT] += WINDOW ** 2
    return (out / np.maximum(norm, 1e-8))[:, N_FFT // 2: N_FFT // 2 + CHUNK]


def to16k_mono(x: np.ndarray) -> np.ndarray:
    """(2, n) at 44.1 kHz → mono 16 kHz (linear interpolation: the mouth only needs the envelope and formants)."""
    mono = x.mean(axis=0)
    t = np.arange(int(len(mono) * OUT_SR / SR)) * (SR / OUT_SR)
    return np.interp(t, np.arange(len(mono)), mono).astype(np.float32)


class Separator:
    def __init__(self, model: Path, threads: int = 4):
        import onnxruntime as ort  # imported here: without it, the face dances without singing

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads  # measured: 4 cores (the M1's "performance" ones) beat 8
        self.session = ort.InferenceSession(str(model), opts, providers=["CPUExecutionProvider"])

    def blocks(self, mix: np.ndarray) -> Iterator[tuple[int, int, np.ndarray]]:
        """For each block, in order: (index, number of blocks, this block's mono 16 kHz voice)."""
        n = mix.shape[1]
        total = max(1, -(-n // BLOCK))
        padded = np.pad(mix, ((0, 0), (TRIM, TRIM + total * BLOCK - n)))
        for k in range(total):
            seg = padded[:, k * BLOCK: k * BLOCK + CHUNK]
            spec = self.session.run(None, {"input": stft(seg)})[0]
            vocal = istft(spec)[:, TRIM: TRIM + BLOCK]
            end = min(BLOCK, n - k * BLOCK)
            yield k, total, to16k_mono(vocal[:, :end])

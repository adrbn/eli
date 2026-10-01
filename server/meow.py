"""Synthesized meows (no samples): a cat voice = a pitch that rises then falls, through formants gliding
from "ee" to "ah" to "oo" (mee-ah-oo). Additive synthesis, harmonic by harmonic."""
from __future__ import annotations

import io
import wave

import numpy as np

SR = 22050
# (duration s, start pitch Hz, peak Hz, end Hz, trill Hz or 0)
KINDS = {
    "miaou": (0.62, 520, 820, 430, 0),
    "mew": (0.32, 760, 980, 700, 0),
    "mrrp": (0.36, 430, 600, 520, 28),
}


def _resonance(f: np.ndarray, center: np.ndarray, width: float) -> np.ndarray:
    return 1 / (1 + ((f - center) / width) ** 2)


def synth(kind: str = "miaou", rng: np.random.Generator | None = None) -> np.ndarray:
    rng = rng or np.random.default_rng()
    dur, f_start, f_peak, f_end, trill = KINDS[kind]
    dur *= rng.uniform(0.85, 1.2)
    shift = rng.uniform(0.9, 1.12)
    n = int(SR * dur)
    u = np.linspace(0, 1, n)
    rise = np.clip(u / 0.35, 0, 1)
    fall = np.clip((u - 0.35) / 0.65, 0, 1)
    f0 = shift * np.where(u < 0.35, f_start + (f_peak - f_start) * np.sin(rise * np.pi / 2),
                          f_peak + (f_end - f_peak) * fall ** 1.4)
    f0 *= 1 + 0.012 * np.sin(2 * np.pi * 6 * u * dur)  # slight vibrato
    phase = 2 * np.pi * np.cumsum(f0) / SR
    # Formants: a nasal "m" at the very start, then ee → ah → oo.
    f1 = np.interp(u, [0, 0.08, 0.3, 0.6, 1], [300, 450, 950, 800, 420]) * shift
    f2 = np.interp(u, [0, 0.08, 0.3, 0.6, 1], [1400, 2300, 1600, 1300, 900]) * shift
    out = np.zeros(n)
    for k in range(1, 24):
        fk = k * f0
        gain = (_resonance(fk, f1, 160) + 0.7 * _resonance(fk, f2, 260) + 0.25 * _resonance(fk, 3200 * shift, 500)) / k ** 0.6
        out += gain * np.sin(k * phase) * (fk < SR / 2 - 500)
    out += 0.015 * rng.standard_normal(n) * np.interp(u, [0, 0.1, 1], [1, 0.3, 0.6])  # a bit of breath
    env = np.minimum(1, u / 0.06) * np.minimum(1, (1 - u) / 0.25) ** 1.5
    if trill:  # the "rrr": the voice cuts in and out very fast
        env *= 0.55 + 0.45 * np.sin(2 * np.pi * trill * u * dur) ** 2
    out *= env
    return (0.6 * out / (np.abs(out).max() + 1e-9)).astype(np.float32)


def wav(kind: str | None = None, rng: np.random.Generator | None = None) -> bytes:
    rng = rng or np.random.default_rng()
    kind = kind or rng.choice(["miaou", "miaou", "mew", "mrrp"])
    pcm = (synth(str(kind), rng) * 32767).astype(np.int16)
    pcm = np.concatenate([np.zeros(int(0.05 * SR), np.int16), pcm, np.zeros(int(0.08 * SR), np.int16)])
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


if __name__ == "__main__":
    import sys

    for k in KINDS:
        x = synth(k, np.random.default_rng(1))
        assert 0.25 < len(x) / SR < 0.8 and np.isfinite(x).all() and 0.5 < np.abs(x).max() <= 0.61, k
    if len(sys.argv) > 1:
        open(sys.argv[1], "wb").write(b"".join([wav(k, np.random.default_rng(i)) for i, k in enumerate(["miaou", "mew", "mrrp"])][:1]))
    print("ok")

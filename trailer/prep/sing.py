"""Eli sings: each spoken syllable (prep/voice.py) is put on its note with the WORLD vocoder, which keeps the voice's
timbre and replaces its pitch and length. Writes public/voice/song.wav, starting at the drop.
Run: uv run --no-project --with pyworld --with "setuptools<81" --with numpy --with scipy prep/sing.py"""
import json
import wave
from pathlib import Path

import numpy as np
import pyworld as pw

HERE = Path(__file__).resolve().parents[1]
VOICE = HERE / "public" / "voice"
score = json.load(open(HERE / "src" / "data" / "score.json"))
DROP, SONG = score["bands"]["DROP"], score["song"]
FP = 5.0  # WORLD frame period, ms
TRANSPOSE = -12  # the synth lead's octave is too high for a speaking voice: she sings an octave under it


def hz(m):
    return 440.0 * 2 ** ((m + TRANSPOSE - 69) / 12)


def read(path):
    with wave.open(str(path)) as w:
        fs = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16) / 32768
    loud = np.flatnonzero(np.abs(x) > 0.02)
    return x[max(0, loud[0] - 200): loud[-1] + 400].astype(np.float64), fs


def sing(x, fs, note, prev, dur):
    f0, t = pw.harvest(x, fs, f0_floor=70, f0_ceil=500, frame_period=FP)
    sp, ap = pw.cheaptrick(x, f0, t, fs), pw.d4c(x, f0, t, fs)
    voiced = np.flatnonzero(f0 > 0)
    v0, v1 = (voiced[0], voiced[-1] + 1) if len(voiced) else (0, len(f0))
    m = max(8, int(dur * 1000 / FP))
    # consonants keep their length, the vowel stretches to fill the note (unless the consonants alone overflow it)
    onset, coda = np.arange(v0), np.arange(v1, len(f0))
    if len(onset) + len(coda) > 0.5 * m:
        k = 0.5 * m / (len(onset) + len(coda))
        onset = np.linspace(0, v0 - 1, max(1, int(len(onset) * k))).astype(int) if v0 else onset
        coda = np.linspace(v1, len(f0) - 1, max(1, int(len(coda) * k))).astype(int) if len(coda) else coda
    body = np.linspace(v0, v1 - 1, m - len(onset) - len(coda)).round().astype(int)
    idx = np.concatenate([onset, body, coda])
    tt = np.arange(len(body)) * FP / 1000
    glide = hz(prev) + (hz(note) - hz(prev)) * np.minimum(1, tt / 0.04) if prev else np.full(len(body), hz(note))
    vib = 1 + 0.012 * np.sin(2 * np.pi * 5.5 * tt) * np.clip((tt - 0.18) * 4, 0, 1)
    f0n = np.concatenate([np.zeros(len(onset)), glide * vib, np.zeros(len(coda))])
    f0n[f0[idx] == 0] = 0  # a voiceless frame stays voiceless
    y = pw.synthesize(f0n, np.ascontiguousarray(sp[idx]), np.ascontiguousarray(ap[idx]), fs, FP)
    fade = min(len(y) // 4, int(0.006 * fs))
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    return y


fs = read(VOICE / "syl" / "00.wav")[1]
end = max(n["t"] + n["d"] for n in SONG) - DROP + 0.5
out = np.zeros(int(end * fs))
prev = None
for i, n in enumerate(SONG):
    x, _ = read(VOICE / "syl" / f"{i:02}.wav")
    y = sing(x, fs, n["m"], prev, n["d"] - 0.02)
    a = int((n["t"] - DROP) * fs)
    out[a: a + len(y)] += y[: len(out) - a]
    prev = n["m"]
out *= 0.8 / np.max(np.abs(out))
with wave.open(str(VOICE / "song.wav"), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(fs)
    w.writeframes((out * 32767).astype(np.int16).tobytes())
print("song.wav", round(len(out) / fs, 2), "s")

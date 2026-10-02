"""The trailer's score, synthesized from scratch (no samples, no licences): 120 BPM, Am F C G.
Writes public/score.wav (music + Eli's lines) and src/data/score.json (the melody Eli sings, for his lips)."""
import json
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR, LEN, BEAT = 44100, 53.0, 0.5
HERE = Path(__file__).resolve().parents[1]
N = int(SR * LEN)
t_all = np.arange(N) / SR
rng = np.random.default_rng(7)

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def at(t): return int(t * SR)
def lp(x, f, order=2): return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)
def env_ar(n, a, r):
    e = np.ones(n); na = max(1, int(a * SR)); nr = max(1, int(r * SR))
    e[:na] = np.linspace(0, 1, na); e[-nr:] *= np.linspace(1, 0, nr); return e
def add(buf, x, t):
    i = at(t); j = min(len(buf), i + len(x))
    if j > i: buf[i:j] += x[: j - i]

CHORDS = [[57, 60, 64, 71], [53, 57, 60, 64], [48, 55, 60, 64], [55, 59, 62, 69]]  # Am9 F C G6, one per bar
ROOTS = [33, 29, 36, 31]

# Bands of the timeline (seconds), shared with the video through score.json.
WAKE, MOODS, THEMES, ASK, DROP, WALL, DEVICES, FINALE, OFF = 6, 14, 18, 22, 24, 34, 40, 46, 50.6

# Pad: detuned saws, filter opening over the whole piece, quieter in the breakdown.
pad = np.zeros(N)
for bar in range(int(LEN / 2) + 1):
    t0 = bar * 2.0
    if t0 >= LEN: break
    n = min(at(2.15), N - at(t0)); tt = np.arange(n) / SR
    v = np.zeros(n)
    for m in CHORDS[bar % 4]:
        for d in (-0.08, 0.0, 0.07):
            ph = (hz(m + d) * tt + rng.random()) % 1
            v += 2 * ph - 1
    add(pad, v * env_ar(n, 0.25, 0.3), t0)
bright = np.interp(t_all, [0, 6, 14, 22, 24, 34, 40, 46, 50, 53], [300, 700, 1400, 900, 2600, 1800, 1500, 2000, 500, 200])
blocks = 512; out = np.zeros(N)
for i in range(0, N, blocks * 64):  # cutoff steps every ~0.75 s, crossfaded
    seg = pad[max(0, i - 4096): i + blocks * 64]
    f = lp(seg, bright[min(N - 1, i)])
    out[i: i + blocks * 64] = f[-len(pad[i: i + blocks * 64]):]
pad = out * np.interp(t_all, [0, 0.5, 2, 22, 22.3, 24, 46, 47, 50.6, 51.5, 53], [0, 0, .5, .55, .7, .45, .45, .7, .5, 0, 0]) * 0.05

# Pluck arpeggio (16ths), from the wake to the finale, out during the question.
arp = np.zeros(N)
step = BEAT / 4
for k in range(int(WAKE / step), int(FINALE / step)):
    t0 = k * step
    if ASK <= t0 < DROP: continue
    ch = CHORDS[int(t0 // 2) % 4]
    m = (ch + [c + 12 for c in ch])[[0, 2, 1, 3, 2, 4, 3, 5][k % 8]] + 12
    n = at(0.35); tt = np.arange(n) / SR
    tone = (2 * ((hz(m) * tt) % 1) - 1) * np.exp(-tt * 14)
    add(arp, lp(tone, 3500) * (0.9 if k % 4 == 0 else 0.6), t0)
arp *= np.interp(t_all, [0, 6, 10, 14, 34, 40, 46, 53], [0, 0.4, .7, .8, .8, .55, .3, 0]) * 0.11

# Drums.
def kick(gain=1.0, long=False):
    n = at(0.9 if long else 0.45); tt = np.arange(n) / SR
    f = 45 + 110 * np.exp(-tt * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * (3 if long else 7)) * gain
def clap():
    n = at(0.25); tt = np.arange(n) / SR
    return bp(rng.standard_normal(n), 900, 3500) * (np.exp(-tt * 18) + 0.6 * np.exp(-((tt - 0.012) % 0.011) * 300) * (tt < 0.035))
def hat(open_=False):
    n = at(0.18 if open_ else 0.05); tt = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-tt * (18 if open_ else 80))
drums = np.zeros(N)
for b in range(int(MOODS / BEAT), int(FINALE / BEAT)):
    t0 = b * BEAT
    if ASK <= t0 < DROP: continue
    full = DROP <= t0 < WALL
    add(drums, kick(0.9 if full else 0.6), t0)
    if full or t0 >= THEMES:
        if b % 2 == 1: add(drums, clap() * (0.5 if full else 0.3), t0)
    for h in range(2 if not full else 4):
        add(drums, hat(full and h == 2) * (0.22 if h % 2 else 0.12), t0 + h * BEAT / (2 if not full else 4))
for i in range(8):  # roll into the drop
    add(drums, clap() * (0.15 + 0.05 * i), ASK + 1.0 + i * 0.125)

# Bass: sidechained to the kick, from the moods on.
bass = np.zeros(N)
for b in range(int(MOODS / BEAT), int(FINALE / BEAT)):
    t0 = b * BEAT
    if ASK <= t0 < DROP: continue
    m = ROOTS[int(t0 // 2) % 4] + 12
    n = at(BEAT); tt = np.arange(n) / SR
    tone = np.sin(2 * np.pi * hz(m) * tt) + 0.35 * np.sin(4 * np.pi * hz(m) * tt)
    duck = 1 - 0.85 * np.exp(-tt * 14)
    add(bass, tone * duck * env_ar(n, 0.005, 0.03), t0)
bass *= 0.22

# Lead: the melody Eli sings (lyrics below, one syllable per note) [eighth, length in eighths, midi, syllable, vowel].
SONG = [
    (0, 1, 76, 'Lit', 'i'), (1, 1, 76, 'up', 'a'), (2, 1, 74, 'in', 'i'), (3, 1, 72, 'the', 'e'), (4, 3, 74, 'dark,', 'a'),
    (7, 1, 69, "I'm", 'a'), (8, 1, 72, 'a', 'e'), (9, 1, 76, 'lit', 'i'), (10, 1, 76, 'tle', 'e'), (11, 2, 79, 'green', 'i'), (13, 3, 76, 'spark', 'a'),
    (16, 1, 76, 'Sing', 'i'), (17, 1, 74, 'it', 'i'), (18, 2, 72, 'loud,', 'o'), (20, 1, 76, 'sing', 'i'), (21, 1, 74, 'it', 'i'), (22, 2, 69, 'low,', 'o'),
    (24, 1, 72, 'ev', 'e'), (25, 1, 72, 'ery', 'i'), (26, 2, 74, 'song', 'o'), (28, 1, 72, 'that', 'a'), (29, 1, 74, 'you', 'u'), (30, 2, 76, 'know', 'o'),
    (32, 6, 81, 'ohh', 'o'),
]
LINES = [[0, 11], [11, 23], [23, 24]]
lead = np.zeros(N)
for e8, ln, m, _, _ in SONG:
    t0, d = DROP + e8 * BEAT / 2, ln * BEAT / 2 - 0.03
    n = at(d + 0.12); tt = np.arange(n) / SR
    vib = 1 + 0.006 * np.sin(2 * np.pi * 5.5 * tt) * np.clip((tt - 0.15) * 4, 0, 1)
    ph = np.cumsum(hz(m) * vib) / SR
    tone = 0.6 * (2 * np.abs(2 * (ph % 1) - 1) - 1) + 0.4 * np.sign(np.sin(2 * np.pi * ph)) * 0.5
    e = np.minimum(1, tt / 0.02) * np.where(tt < d, 1 - 0.25 * np.minimum(1, tt / 0.3), np.maximum(0, 1 - (tt - d) / 0.12) * 0.75)
    add(lead, lp(tone, 2800) * e, t0)
lead *= 0.05  # under Eli's voice now (prep/sing.py), it only doubles her melody

# Effects: the first pixel's tick, theme-switch blips, the riser, three impacts.
fx = np.zeros(N)
n = at(0.08); tt = np.arange(n) / SR
add(fx, np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt * 70) * 0.25, 0.5)
for k in range(8):
    n = at(0.07); tt = np.arange(n) / SR
    add(fx, np.sign(np.sin(2 * np.pi * (900 + 160 * k) * tt)) * np.exp(-tt * 50) * 0.04, THEMES + k * BEAT)
n = at(2.0); tt = np.arange(n) / SR
riser = bp(rng.standard_normal(n), 400, 9000) * (tt / 2.0) ** 2.5 * 0.35
riser += np.sin(2 * np.pi * np.cumsum(200 + 900 * (tt / 2) ** 2) / SR) * (tt / 2) ** 2 * 0.12
add(fx, riser, ASK)
def impact(g):
    n = at(2.5); tt = np.arange(n) / SR
    return (kick(1.0, True)[:n] if n <= at(0.9) else np.pad(kick(1.0, True), (0, n - at(0.9)))) * g + lp(rng.standard_normal(n), 900) * np.exp(-tt * 3) * 0.25 * g
for t0, g in ((WAKE, 0.8), (DROP, 1.0), (FINALE, 1.0)):
    add(fx, impact(g), t0)

# Reverb on pad, arp and lead.
ir_n = at(2.4); ir_t = np.arange(ir_n) / SR
ir = rng.standard_normal(ir_n) * np.exp(-ir_t * 2.6); ir = lp(ir, 5000); ir /= np.sqrt(np.sum(ir ** 2))
wet_src = pad * 0.8 + arp + lead * 0.7 + fx * 0.3
wet = fftconvolve(wet_src, ir)[:N] * 0.35

mix = pad + arp + drums * 0.9 + bass + lead + fx + wet

# Eli's lines, ducking the music.
VOICE = {'hi': WAKE + 0.7, 'eli': 10.3, 'sing': ASK + 0.2, 'song': DROP, 'night': 49.4}
duck = np.ones(N)
voice = np.zeros(N)
for key, t0 in VOICE.items():
    with wave.open(str(HERE / 'public' / 'voice' / f'{key}.wav')) as w:
        r = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16) / 32768
    y = np.interp(np.arange(int(len(x) * SR / r)) * r / SR, np.arange(len(x)), x)
    add(voice, y * 0.9, t0)
    i, j = at(t0 - 0.1), at(t0 + len(y) / SR + 0.2)
    duck[i:j] = 0.75 if key == 'song' else 0.55  # she sings over the band, not instead of it
duck = np.convolve(duck, np.ones(2205) / 2205, mode='same')
voice_wet = fftconvolve(voice, ir[: at(0.8)])[:N] * 0.08
mix = mix * duck + voice + voice_wet

mix = np.tanh(mix * 1.6) / 1.6  # gentle limiter
mix /= np.max(np.abs(mix)) / 0.89
mix *= np.interp(t_all, [0, OFF, LEN], [1, 1, 0]) ** 1.5  # he falls asleep: the music drifts off with him
st = np.stack([mix, np.roll(mix, 9)], axis=1)  # a hint of width
with wave.open(str(HERE / 'public' / 'score.wav'), 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st * 32767).astype(np.int16).tobytes())

json.dump({
    'bands': dict(WAKE=WAKE, MOODS=MOODS, THEMES=THEMES, ASK=ASK, DROP=DROP, WALL=WALL, DEVICES=DEVICES, FINALE=FINALE, OFF=OFF, LEN=LEN),
    'voice': VOICE,
    'song': [dict(t=DROP + e8 * BEAT / 2, d=ln * BEAT / 2, m=m, s=s, v=v) for e8, ln, m, s, v in SONG],
    'lines': LINES,
}, open(HERE / 'src' / 'data' / 'score.json', 'w'))
print('ok', round(float(np.max(np.abs(mix))), 3))

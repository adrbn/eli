// Eli's performance, directed: the same { eyes, mouth } state the app's face.js produces, scripted per second so
// every glance lands on the music. The themes from web/js draw it exactly as the app does.
import score from '../data/score.json';
import voice from '../data/voice.json';
import { BREATH, MOODS } from '../../../web/js/face.js';
import { Notes } from '../../../web/js/looks.js';
import { BEAT, bell, beatPulse, clamp, pulse, range, seeded, track, withRandom } from './time.js';

export const B = score.bands;
export const SONG = score.song;

export const MOOD_SEQ = [['joie', 'JOY'], ['surprise', 'SURPRISE'], ['amour', 'LOVE'], ['malice', 'MISCHIEF'], ['colère', 'ANGER'], ['tristesse', 'SADNESS'], ['gêne', 'SHY'], ['rire', 'LAUGHTER']];
export const THEME_SEQ = [
  ['blocs', 'Blocks', 'OLED, chunky square pixels'], ['perles-fond', 'Lit beads', 'Color LED matrix'], ['trait', 'Line', 'Round eyes, real lips'],
  ['trait-neon', 'Neon', 'Glowing outlines'], ['chat-pixel', 'Pixel cat', 'Ears that twitch'], ['chaton', 'Kitten', 'Big eyes, pink cheeks'],
  ['matrice', 'Matrix', 'Round 19×19 LED matrix'], ['oscillo', 'Oscillo', 'An oscilloscope trace'],
];
export const BARS = [['perles-fond', 'tropical', 'TROPICAL'], ['pixel', 'electro', 'ELECTRO'], ['trait-neon', 'rock', 'ROCK'], ['chat-pixel', 'country', 'COUNTRY'], ['trait-doux', 'chill', 'CHILL']];

export const moodAt = (t) => (t >= B.MOODS && t < B.THEMES ? MOOD_SEQ[Math.floor((t - B.MOODS) / BEAT)][0] : t >= B.ASK && t < B.DROP - 0.25 ? 'malice' : null);
export const barAt = (t) => BARS[clamp(Math.floor((t - B.DROP) / 2), 0, 4)];

const BLINKS = [6.02, 8.35, 9.6, 12.25, 13.75, 18.02, 19.6, 21.1, 22.05, 34.6, 36.9, 38.8, 40.9, 42.4, 44.1, 45.5, 48.1, 49.0];
function blinkAt(t) {
  for (const b of BLINKS) {
    const q = (t - b) / 0.17;
    if (q >= 0 && q < 1) return q < 0.4 ? q / 0.4 : 1 - (q - 0.4) / 0.6;
  }
  return 0;
}

export function voiceAt(t) {
  for (const [key, t0] of Object.entries(score.voice)) {
    const v = voice[key];
    if (t >= t0 && t < t0 + v.dur) {
      const [o, w, r, th] = v.frames[Math.min(v.frames.length - 1, Math.floor((t - t0) * 30))];
      return { o, w, r, t: th };
    }
  }
  return null;
}

export const noteAt = (t) => SONG.find((n) => t >= n.t && t < n.t + n.d + 0.05);
const pitchOf = (n) => (n ? clamp((n.m - 74) / 7, -1, 1) : 0);
const VOWELS = { a: [1, 0.55, 0], e: [0.6, 0.8, 0], i: [0.3, 1, 0], o: [0.6, 0.2, 0.8], u: [0.22, 0, 1] };
function singMouth(t) {
  const n = noteAt(t);
  if (!n) return { o: 0.02, w: 0.35, r: 0.2, t: 0 };
  const u = t - n.t, end = n.d - 0.03;
  const env = Math.min(1, u / 0.04) * (u < end ? 1 - 0.2 * Math.min(1, u / 0.3) : Math.max(0, 1 - (u - end) / 0.08) * 0.8);
  const [o, w, r] = VOWELS[n.v], p = pitchOf(n);
  return { o: Math.min(1, o * env * (1 + 0.3 * Math.max(0, p))), w: Math.min(1, w + 0.25 * Math.max(0, -p)), r: Math.min(1, r + 0.3 * Math.max(0, p)), t: 0 };
}
const avgMouth = (fn, t) => { // the lips glide between syllables instead of snapping
  const s = [0, 1, 2, 3].map((i) => fn(t - i / 120)), k = ['o', 'w', 'r', 't'], out = {};
  for (const key of k) out[key] = (s[0][key] * 4 + s[1][key] * 3 + s[2][key] * 2 + s[3][key]) / 10;
  return out;
};

// Piecewise targets, eased: gaze before the song, moods during the montage.
const GX = [[0, 0], [6.15, -0.75], [6.45, 0.6], [6.75, 0], [8.45, 1.05], [9.25, 0], [10.3, 0.6], [10.85, 0], [12.35, 1.1], [13.55, 0], [14, 0]];
const GY = [[0, 0], [6.15, -0.1], [6.75, 0], [8.45, -0.15], [9.25, 0], [10.3, -0.45], [10.85, 0], [12.35, -0.1], [13.55, 0]];
const HAP = [[0, 0], [6, 0], [7.3, 0.85], [8.6, 0.55], [10.3, 0.7], [12.3, 0.55]];
const moodKeys = (pick, dflt) => [[B.MOODS - 0.01, dflt], ...MOOD_SEQ.map(([m], i) => [B.MOODS + i * BEAT, pick(MOODS[m]) ?? dflt])];
const MK = {
  hap: moodKeys((m) => m.hap, 0), sc: moodKeys((m) => m.sc, 1), sq: moodKeys((m) => m.sq, 0), ang: moodKeys((m) => m.ang, 0),
  tx: moodKeys((m) => m.tx, 0), ty: moodKeys((m) => m.ty, 0),
  o: moodKeys((m) => m.rest.o, 0), w: moodKeys((m) => m.rest.w, 0.3), r: moodKeys((m) => m.rest.r, 0), t: moodKeys((m) => m.rest.t, 0),
};
const SING_GY = SONG.flatMap((n) => [[n.t, -0.1 - 0.55 * pitchOf(n)], [n.t + n.d, -0.1]]);
const SING_HAP = SONG.flatMap((n) => [[n.t, 0.85 - 0.35 * Math.max(0, pitchOf(n))], [n.t + n.d, 1]]);
const SING_SQ = SONG.flatMap((n) => [[n.t, 0.75 * Math.max(0, pitchOf(n))], [n.t + n.d, 0]]);

// The notes, hearts and "!" are the app's own particles (looks.js), simulated forward from the start of their scene.
let sim = null;
function notesAt(t) {
  const start = t >= B.MOODS && t < B.THEMES ? B.MOODS : t >= B.DROP && t < B.WALL ? B.DROP : null;
  if (start === null) return [];
  if (!sim || sim.start !== start || sim.t > t + 1e-6) sim = { start, t: start, notes: new Notes(), rng: seeded(42) };
  while (sim.t + 1 / 120 < t) {
    const dt = 1 / 60, t1 = sim.t + dt, singing = start === B.DROP;
    const beat = singing && Math.floor((t1 - B.DROP) / BEAT) !== Math.floor((sim.t - B.DROP) / BEAT) ? 1 : 0;
    withRandom(sim.rng, () => sim.notes.update(dt, singing, beat, singing ? null : moodAt(t1)));
    sim.t = t1;
  }
  return sim.notes.list.map((n) => ({ ...n }));
}

export function faceAt(t) {
  let gx = 0, gy = 0, hap = 0.55, sc = 1, sq = 0, ang = 0, bo = 0, cl = 0, sleep = 0, look = null;
  let mouth = { o: 0, w: 0.3, r: 0, t: 0 };
  const phase = (t / BREATH) % 1;

  if (t < B.WAKE) sleep = 1;
  else if (t < B.MOODS) {
    sleep = Math.exp(-6 * (t - B.WAKE));
    sc = 1 + 0.3 * Math.exp(-6 * (t - B.WAKE));
    gx = track(t, GX, 20); gy = track(t, GY, 20);
    hap = track(t, HAP, 6);
    mouth = { o: 0.03 * hap, w: 0.3 + 0.4 * hap, r: 0, t: 0 };
  } else if (t < B.THEMES) {
    const m = moodAt(t), md = MOODS[m];
    hap = track(t, MK.hap, 9); sc = track(t, MK.sc, 9); sq = track(t, MK.sq, 9); ang = track(t, MK.ang, 9);
    gx = track(t, MK.tx, 12); gy = track(t, MK.ty, 12);
    mouth = { o: track(t, MK.o, 20), w: track(t, MK.w, 20), r: track(t, MK.r, 20), t: track(t, MK.t, 20) };
    if (md.pulse) sc += md.pulse * Math.max(0, Math.sin(t * 7.5)) ** 8;
    bo = Math.max(beatPulse(t, B.MOODS, B.THEMES) * 0.25, md.bounce ? md.bounce * Math.exp(-7 * ((t - B.MOODS) % 0.32)) : 0);
  } else if (t < B.ASK) {
    const u = t - B.THEMES;
    gx = 0.55 * Math.sin(Math.PI * u); gy = -0.1 + 0.08 * Math.sin(2 * Math.PI * u);
    hap = 0.8; sc = 1.03; bo = beatPulse(t, B.THEMES, B.ASK) * 0.4;
    mouth = { o: 0.04, w: 0.8, r: 0, t: 0 };
  } else if (t < B.DROP) {
    const ready = range(t, 23.75, 23.9);
    gx = 0.45 * (1 - ready); gy = -0.1 - 0.25 * ready;
    hap = 0.6 - 0.3 * ready; sq = 0.15 * (1 - ready); sc = 1 + 0.18 * ready;
    mouth = { o: 0.03 + 0.1 * ready, w: 0.55 - 0.3 * ready, r: 0.6 * ready, t: 0 };
  } else if (t < B.WALL) {
    const n = noteAt(t), p = pitchOf(n);
    gx = 0.4 * Math.sin(Math.PI * (t - B.DROP)); gy = track(t, SING_GY, 8);
    hap = track(t, SING_HAP, 5); sq = track(t, SING_SQ, 6); sc = 1.06 + 0.05 * Math.max(0, -p);
    bo = beatPulse(t, B.DROP, B.WALL) * 0.6;
    cl = range(t, 32.25, 32.45) * (1 - range(t, 33.45, 33.75)); // the long high note: eyes shut, head up
    if (cl > 0.3) { gy = Math.min(gy, -0.35); ang = -0.35 * cl }
    mouth = avgMouth(singMouth, t);
    look = barAt(t)[1];
  } else if (t < B.DEVICES) {
    gx = 0.5 * Math.sin(Math.PI * (t - B.WALL)); gy = -0.1; hap = 0.85; sc = 1.03;
    bo = beatPulse(t, B.WALL, B.DEVICES) * 0.35;
    mouth = { o: 0.06 + 0.08 * Math.abs(Math.sin(4 * Math.PI * t)), w: 0.4, r: 0.5, t: 0 };
  } else if (t < B.FINALE) {
    gx = track(t, [[40, 0], [42.0, 0.7], [42.6, 0], [44.2, -0.6], [44.8, 0]], 20);
    hap = 0.6; mouth = { o: 0.03, w: 0.5, r: 0, t: 0 };
  } else {
    sc = 1 + 0.3 * Math.exp(-6 * (t - B.FINALE));
    const laugh = range(t, 46.6, 46.7) * (1 - range(t, 47.7, 47.9));
    hap = track(t, [[46, 0.2], [46.6, 1], [48.3, 0.7]], 6);
    bo = laugh * 0.5 * Math.exp(-7 * ((t - 46.6) % 0.32));
    mouth = { o: 0.03 + 0.27 * laugh, w: 0.5 + 0.2 * laugh, r: 0.1 * laugh, t: laugh };
    sleep = t < 49.9 ? 0 : 1 - Math.exp(-4 * (t - 49.9));
  }

  const v = voiceAt(t);
  if (v) mouth = v;
  const asleep = sleep > 0.6, inhale = asleep && phase < 0.4 ? bell(phase / 0.4) : 0;
  if (asleep) mouth = { o: 0.05 + 0.17 * inhale, w: 0.25, r: 0.4, t: 0 };
  const breathe = asleep ? 0.03 * inhale : 0.008 * Math.sin(t * 1.6);
  const open = (1 - blinkAt(t) * 0.93) * (1 - sq * 0.4) * (1 - sleep * 0.9) * (1 - cl * 0.9);
  return {
    T: t, asleep, phase, look, gesture: null, sleep,
    eyes: { gx, gy: gy + sleep * 0.3, open, hap, sc: sc + breathe, bo, ang },
    mouth,
    notes: notesAt(t),
  };
}

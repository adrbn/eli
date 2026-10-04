// Analyse hors ligne d'un clip entier, ramené à 16 kHz mono : des pistes à 100 images par seconde.
// Parole → forme de bouche (ouverture, largeur, arrondi, dents), débuts de phrases et pauses.
// Musique → énergie et temps forts (tempo + phase), pour le rebond et le balancement.
// Pur calcul, sans navigateur : tourne dans un Worker et sous `node --test`.
export const SR = 16000;
export const HOP = 0.01;
const N = 512;
const STEP = SR * HOP;
const FLOOR_DB = -55;

const HANN = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
const bin = (hz) => Math.round((hz * N) / SR);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// Parcourt le signal par pas de 10 ms ; `each(f, puissance, centre)` reçoit le spectre de chaque image.
function frames(x, each) {
  const n = Math.max(1, Math.ceil(x.length / STEP));
  const re = new Float32Array(N), im = new Float32Array(N), P = new Float32Array(N / 2 + 1);
  for (let f = 0; f < n; f++) {
    const c = f * STEP;
    for (let i = 0; i < N; i++) {
      const j = c - N / 2 + i;
      re[i] = j >= 0 && j < x.length ? x[j] * HANN[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    each(f, P, c);
  }
  return n;
}

// Niveau sur 20 ms centrées : assez court pour que la bouche se ferme net sur les m, b, p.
function rmsDb(x, c) {
  let s = 0, k = 0;
  for (let i = Math.max(0, c - 160); i < Math.min(x.length, c + 160); i++, k++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, k) + 1e-12);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float32Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

const BANDS = [[90, 350], [350, 900], [900, 2000], [2000, 4000], [4000, 7600]].map(([a, b]) => [bin(a), bin(b)]);

// minRef : plancher de la référence de niveau (dB). Pour une voix isolée encore partielle, celui du mix moins
// 12 dB (mesuré : la voix tient 2 à 7 dB sous le mix) ; sans lui, un premier bloc sans chant calerait la
// référence sur les résidus d'instruments et ouvrirait la bouche dessus.
// pitch = true (voix chantée) : ajoute `pt`, la hauteur de la note autour de la médiane du chanteur (-1 grave … 1 aigu).
export function analyzeSpeech(x, minRef = -Infinity, pitch = false) {
  const db = [], f1 = [], f2 = [], fr = [], lo = [], f0 = [];
  const acRe = new Float32Array(N), acIm = new Float32Array(N);
  const n = frames(x, (f, P, c) => {
    if (pitch) f0[f] = fundamental(P, acRe, acIm);
    const e = BANDS.map(([a, b]) => {
      let s = 0;
      for (let k = a; k < b; k++) s += P[k];
      return s;
    });
    const tot = e[0] + e[1] + e[2] + e[3] + e[4] + 1e-12;
    db[f] = rmsDb(x, c);
    f1[f] = e[1] / (e[0] + e[1] + 1e-12); // 1er formant haut → voyelle ouverte (a)
    f2[f] = e[3] / (e[2] + e[3] + 1e-12); // 2e formant haut → lèvres étirées (i, é)
    fr[f] = e[4] / tot; // souffle aigu → s, f, ch
    lo[f] = (e[0] + e[1]) / tot; // tout dans le grave → lèvres arrondies (o, ou)
  });
  const ref = Math.max(minRef, percentile(db.filter((d) => d > FLOOR_DB), 0.95));
  if (pitch) { // les seuils ci-dessous viennent de la voix parlée de Piper ; une voix chantée (grave, voyelles tenues)
    // se tient ailleurs : « a » grand ouvert partout, largeur figée. Chaque piste est ramenée à sa propre plage.
    const sung = [];
    for (let f = 0; f < n; f++) if (db[f] > ref - 20) sung.push(f);
    const remap = (a, lo, hi) => { // par rang : chaque valeur devient sa place parmi les frames chantées
      const v = Float32Array.from(sung, (f) => a[f]).sort();
      for (let f = 0; f < n; f++) {
        let i = 0, j = v.length;
        while (i < j) { const m = (i + j) >> 1; if (v[m] < a[f]) i = m + 1; else j = m }
        a[f] = lo + (i / v.length) * (hi - lo);
      }
    };
    if (sung.length > 50) { remap(f1, 0.15, 0.85); remap(f2, 0, 0.55); remap(lo, 0.45, 1.0); remap(fr, 0, 0.5) }
  }
  const o = new Float32Array(n), w = new Float32Array(n), r = new Float32Array(n), t = new Float32Array(n), lv = new Float32Array(n);
  // Chanté, la voix tient presque toujours son niveau : ce sont ses creux (consonnes, souffle entre deux syllabes)
  // sous le pic voisin qui referment la bouche, pas le silence.
  const dip = new Float32Array(n).fill(1);
  if (pitch) for (let f = 0; f < n; f++) {
    let peak = -Infinity;
    for (let k = Math.max(0, f - 12); k <= Math.min(n - 1, f + 12); k++) peak = Math.max(peak, db[k]);
    dip[f] = 0.15 + 0.85 * smooth(-14, -4, db[f] - peak);
  }
  const m = springs();
  for (let f = 0; f < n; f++) {
    const level = db[f] < FLOOR_DB || db[f] < ref - 34 ? 0 : clamp((db[f] - (ref - 32)) / 28);
    const fric = smooth(0.25, 0.6, fr[f]);
    const to = level ? level ** 0.8 * (0.35 + 0.65 * smooth(0.25, 0.75, f1[f])) * (1 - 0.6 * fric) * dip[f] : 0;
    const tw = level ? 0.25 + 0.75 * smooth(0.15, 0.55, f2[f]) : 0.3;
    const tr = level > 0.15 ? smooth(0.6, 0.9, lo[f]) * (1 - smooth(0.1, 0.4, f2[f])) : 0;
    o[f] = spring(m.o, to, to > m.o.x ? 85 : to === 0 ? 110 : 65); // s'ouvre vite, se ferme encore plus vite au silence
    w[f] = spring(m.w, tw, 40);
    r[f] = spring(m.r, tr, 34);
    t[f] = spring(m.t, level > 0.1 ? fric : 0, 50);
    lv[f] = level;
  }
  const starts = [], pauses = [];
  for (let f = 0, quiet = 25; f < n; f++) {
    if (lv[f] === 0) {
      if (++quiet === 25) pauses.push(f * HOP);
    } else {
      if (quiet >= 25) starts.push(f * HOP);
      quiet = 0;
    }
  }
  const track = { n, o, w, r, t, lv, starts, pauses };
  if (pitch) track.pt = pitchTrack(f0, lv);
  return track;
}

// Fréquence fondamentale (Hz) par autocorrélation (= transformée du spectre de puissance), ou 0 si pas de note.
function fundamental(P, re, im) {
  for (let k = 0; k <= N / 2; k++) { re[k] = P[k]; im[k] = 0 }
  for (let k = N / 2 + 1; k < N; k++) { re[k] = P[N - k]; im[k] = 0 }
  fft(re, im);
  if (re[0] <= 0) return 0;
  let best = 0, lag = 0;
  for (let L = 20; L <= 200; L++) if (re[L] > best) { best = re[L]; lag = L } // 80 à 800 Hz
  if (best / re[0] < 0.35) return 0; // souffle, consonne, silence
  for (const d of [3, 2]) { // le meilleur pic peut être l'octave du dessous : on essaie ses sous-multiples
    const L = Math.round(lag / d);
    if (L >= 20 && Math.max(re[L - 1], re[L], re[L + 1]) >= 0.9 * best) return SR / L;
  }
  return SR / lag;
}

function pitchTrack(f0, lv) {
  const voiced = f0.filter((v, i) => v > 0 && lv[i] > 0.15);
  const mid = voiced.length ? percentile(voiced, 0.5) : 0, pt = new Float32Array(f0.length);
  for (let i = 0, p = 0; i < f0.length; i++) {
    const target = mid && f0[i] > 0 && lv[i] > 0.15 ? clamp((12 * Math.log2(f0[i] / mid)) / 9, -1, 1) : p * 0.98;
    p += (target - p) * 0.25;
    pt[i] = p;
  }
  return pt;
}

export function analyzeMusic(x) {
  const half = N / 2, prev = new Float32Array(half + 1), lowEnd = bin(200);
  const flux = [], low = [], db = [];
  const n = frames(x, (f, P, c) => {
    let s = 0, sl = 0;
    for (let k = 1; k <= half; k++) {
      const m = Math.log1p(100 * Math.sqrt(P[k]));
      const d = m - prev[k];
      prev[k] = m;
      if (d > 0) {
        s += d;
        if (k <= lowEnd) sl += d;
      }
    }
    flux[f] = s; low[f] = sl; db[f] = rmsDb(x, c);
  });
  let mf = 1e-9, ml = 1e-9;
  for (let f = 0; f < n; f++) { mf = Math.max(mf, flux[f]); ml = Math.max(ml, low[f]) }
  const raw = new Float32Array(n), env = new Float32Array(n), sum = new Float64Array(n + 1);
  for (let f = 0; f < n; f++) { raw[f] = flux[f] / mf + (2 * low[f]) / ml; sum[f + 1] = sum[f] + raw[f] }
  let me = 1e-9;
  for (let f = 0; f < n; f++) { // attaque = au-dessus de la moyenne locale (1 s)
    const a = Math.max(0, f - 50), b = Math.min(n, f + 51);
    env[f] = Math.max(0, raw[f] - (sum[b] - sum[a]) / (b - a));
    me = Math.max(me, env[f]);
  }
  let lag = 50, best = -1; // tempo : autocorrélation entre 60 et 200 bpm, avec une préférence douce pour ~120
  for (let L = 30; L <= 100; L++) {
    let s = 0;
    for (let f = L; f < n; f++) s += env[f] * env[f - L];
    s *= Math.exp(-0.5 * Math.log2(6000 / L / 120) ** 2);
    if (s > best) { best = s; lag = L }
  }
  let phase = 0, bp = -1; // phase : celle qui tombe le plus souvent sur des attaques (30 premières secondes)
  for (let p = 0; p < lag; p++) {
    let s = 0;
    for (let f = p; f < Math.min(n, 3000); f += lag) s += env[f];
    if (s > bp) { bp = s; phase = p }
  }
  const beats = [], strength = [], win = Math.max(2, Math.round(lag * 0.12));
  for (let f = phase; f < n;) { // on suit les temps en se recalant sur l'attaque la plus proche
    let at = f, v = -1;
    for (let k = Math.max(0, f - win); k <= Math.min(n - 1, f + win); k++) if (env[k] > v) { v = env[k]; at = k }
    if (v < 0.15 * me) at = f;
    beats.push(at * HOP);
    strength.push(Math.sqrt(clamp(env[at] / me)));
    f = at + lag;
  }
  const lo10 = percentile(db.filter((d) => d > -80), 0.1), hi95 = percentile(db.filter((d) => d > -80), 0.95);
  const energy = new Float32Array(n);
  for (let f = 0, e = 0; f < n; f++) {
    const v = clamp((db[f] - lo10) / (hi95 - lo10 + 1e-6));
    e += (v - e) * (v > e ? 0.3 : 0.03);
    energy[f] = e;
  }
  return { n, bpm: 6000 / lag, period: lag * HOP, beats: Float32Array.from(beats), strength: Float32Array.from(strength), energy, level: hi95 };
}

// Valeur d'une piste au temps t (s), interpolée entre deux images.
export function sample(track, key, t) {
  const a = track[key], f = t / HOP;
  if (f <= 0) return a[0];
  const i = Math.floor(f);
  if (i >= track.n - 1) return a[track.n - 1];
  const k = f - i;
  return a[i] * (1 - k) + a[i + 1] * k;
}

// Un muscle plutôt qu'un aimant : ressort amorti critique, résolu exactement sur un pas. Il part en douceur et arrive
// sans rebond, là où un lissage simple démarre à pleine vitesse et fait sauter la bouche d'une forme à l'autre.
// k : raideur (rad/s), ~90 % du chemin en 3,9/k secondes.
const spring = (s, to, k) => {
  const e = s.x - to, j = (s.v + k * e) * HOP, d = Math.exp(-k * HOP);
  s.x = to + (e + j) * d;
  s.v = (s.v - k * j) * d;
  return s.x;
};
const springs = () => ({ o: { x: 0, v: 0 }, w: { x: 0.3, v: 0 }, r: { x: 0, v: 0 }, t: { x: 0, v: 0 } });

// Les lèvres de chaque phonème (alphabet d'espeak) : [ouverture, largeur, arrondi, dents].
const VISEMES = {};
for (const [chars, v] of [
  ['aɑɐæʌ', [1, 0.55, 0, 0]], ['ɛeɜɚ', [0.6, 0.8, 0, 0.2]], ['iɪj', [0.3, 1, 0, 0.4]], ['əœøɵ', [0.45, 0.35, 0.5, 0]],
  ['y', [0.2, 0.1, 0.9, 0]], ['uʊwɥ', [0.22, 0, 1, 0]], ['oɔɒ', [0.6, 0.2, 0.8, 0]], ['mbp', [0, 0.45, 0, 0]],
  ['fv', [0.08, 0.5, 0, 1]], ['szθð', [0.15, 0.75, 0, 1]], ['ʃʒ', [0.25, 0.2, 0.75, 0.8]], ['tdnlɾ', [0.25, 0.55, 0, 0.4]],
  ['kgɡŋʁɹhxχ', [0.35, 0.45, 0.1, 0]], ['ɲ', [0.25, 0.6, 0, 0.2]],
]) for (const c of chars) VISEMES[c] = v;
const LEAD = 0.04; // les lèvres se placent un peu avant le son (et les ressorts mettent ~2/k à suivre)

// Phonèmes alignés par la voix ([[phonème, ms], …]) → pistes de lèvres à 100 images/s. Les accents (ˈ) comptent
// pour le phonème suivant, les longueurs (ː) et la nasale (◌̃) pour le précédent ; espaces et ponctuation = repos.
export function visemeTrack(phonemes, n) {
  const spans = [];
  let t = 0;
  for (const [p, ms] of phonemes) {
    const v = VISEMES[p] || (/\p{L}/u.test(p) ? [0.3, 0.4, 0, 0] : null);
    spans.push({ p, v, start: t, end: (t += ms / 1000) });
  }
  spans.forEach((s, i) => { if (s.p === 'ː' || s.p === '\u0303') s.v = spans[i - 1]?.v ?? null });
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i].p === 'ˈ' || spans[i].p === 'ˌ') spans[i].v = spans[i + 1]?.v ?? null;
  const vo = new Float32Array(n), vw = new Float32Array(n), vr = new Float32Array(n), vt = new Float32Array(n);
  const m = springs(), cur = { k: 0 }, ahead = { k: 0 };
  const at = (c, t) => { // le visème à l'instant t (pointeur qui ne fait qu'avancer)
    while (c.k < spans.length - 1 && spans[c.k].end <= t) c.k++;
    const s = spans[c.k];
    return s && t >= s.start && t < s.end ? s.v : null;
  };
  for (let f = 0; f < n; f++) {
    // Les lèvres anticipent le son, sauf pour rouvrir : un « m », « b », « p » reste fermé jusqu'au bout.
    const now = at(cur, f * HOP), next = at(ahead, f * HOP + LEAD), v = now && now[0] < 0.05 ? now : next;
    const [to, tw, tr, tt] = v || [0, 0.3, 0, 0];
    vo[f] = spring(m.o, to, to < 0.05 ? 110 : 70); // les fermetures (m, b, p) claquent, l'ouverture suit le son
    vw[f] = spring(m.w, tw, 45);
    vr[f] = spring(m.r, tr, 38); // arrondir les lèvres est le geste le plus lent
    vt[f] = spring(m.t, tt, 50);
  }
  return { vo, vw, vr, vt };
}

export function mouthAt(track, t) {
  if (!track || t < 0 || t > track.n * HOP) return null;
  if (track.vo) { // forme des lèvres par les phonèmes, amplitude par le son
    const lv = sample(track, 'lv', t);
    return { o: sample(track, 'vo', t) * (0.55 + 0.45 * lv), w: sample(track, 'vw', t), r: sample(track, 'vr', t), t: sample(track, 'vt', t) };
  }
  return { o: sample(track, 'o', t), w: sample(track, 'w', t), r: sample(track, 'r', t), t: sample(track, 't', t) };
}

// Indice du premier repère franchi entre deux instants (a exclu, b inclus), ou -1.
export function crossed(times, a, b) {
  for (let i = 0; i < times.length; i++) if (times[i] > a && times[i] <= b) return i;
  return -1;
}

export function encodeWav(samples, sr) {
  const v = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, clamp(samples[i], -1, 1) * 0x7fff, true);
  return v.buffer;
}

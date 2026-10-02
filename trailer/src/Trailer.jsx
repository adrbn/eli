// The trailer, scene by scene. t is the only clock; the score (prep/score.py) shares its bands with the picture.
import React from 'react';
import { AbsoluteFill, Audio, staticFile, useCurrentFrame } from 'remotion';
import { FaceCanvas } from './components/FaceCanvas.jsx';
import { Esp32, IPhone, MacBook } from './components/Devices.jsx';
import { GREEN, INK, MONO, Reveal, SANS, Typed } from './components/Type.jsx';
import { B, BARS, MOOD_SEQ, SONG, THEME_DUR, THEME_SEQ, barAt, faceAt } from './lib/face.js';
import score from './data/score.json';
import { BEAT, FPS, beatPulse, bounce, clamp, easeIn, easeInOut, easeOut, expoOut, mix, pulse, range, spring } from './lib/time.js';

const DIM = 'rgba(238,243,238,.55)';
const BARS_T = [0, 1, 2, 3, 4].map((i) => B.DROP + 2 * i);
const BEATS = (a, b) => Array.from({ length: Math.round((b - a) / BEAT) }, (_, i) => a + i * BEAT);

function heroTheme(t) {
  if (t >= B.THEMES && t < B.ASK) return THEME_SEQ[Math.floor((t - B.THEMES) / THEME_DUR)][0];
  if (t >= B.DROP) return barAt(t)[0];
  return 'pixel';
}

function heroCamera(t) {
  let s = 1, x = 0, y = 0;
  if (t < B.WAKE) s = 2.7 - 1.7 * easeOut(range(t, 1.0, B.WAKE));
  else if (t < 10) s = 1 + 0.05 * pulse(t, [B.WAKE], 5);
  else if (t < B.MOODS) { const k = spring(t, 10, 7); s = 1 - 0.38 * k; x = -440 * k }
  else if (t < B.ASK) {
    const k = spring(t, B.MOODS, 9);
    s = mix(0.62, 0.84, k) + 0.035 * pulse(t, BEATS(B.MOODS, B.ASK), 9); x = -440 * (1 - k);
  } else if (t < B.DROP) {
    s = 0.84 + 0.36 * easeIn(range(t, B.ASK, B.DROP));
    const shake = range(t, 23.55, 24) * 7;
    x = Math.sin(t * 97) * shake; y = Math.cos(t * 83) * shake;
  } else {
    s = 0.74 + 0.04 * pulse(t, BARS_T, 6) + 0.015 * beatPulse(t, B.DROP, B.WALL, 10); y = -50;
    s += 0.08 * (1 - spring(t, B.DROP, 8)); // lands from the push-in
  }
  return { s, x, y };
}

// CRT power-on at the start, power-off at the end: a dot, a line, then the whole screen.
function crt(t) {
  if (t < 3) {
    const w = easeOut(range(t, 1.0, 1.28)), h = easeOut(range(t, 1.28, 1.65));
    return { clip: `inset(${(1 - h) * 49.4}% ${(1 - w) * 50}% ${(1 - h) * 49.4}% ${(1 - w) * 50}%)`, flash: t > 1.25 ? Math.exp(-12 * (t - 1.28)) * 0.14 : 0, on: t >= 1.0 };
  }
  return { clip: 'none', flash: 0, on: true };
}

function Zzz({ t, opacity }) {
  return (
    <div style={{ position: 'absolute', right: 200, top: 120, display: 'flex', gap: 14, alignItems: 'flex-end', fontFamily: MONO, color: GREEN, opacity, textShadow: `0 0 16px ${GREEN}` }}>
      {[0, 1, 2].map((i) => {
        const u = ((t + i * 0.5) / 3.2) % 1;
        return <span key={i} style={{ fontSize: 44 + i * 24, transform: `translateY(${-u * 26}px)`, opacity: Math.sin(Math.PI * u) }}>z</span>;
      })}
    </div>
  );
}

function MacWindow({ t }) {
  const o = range(t, 12.6, 13.1) * (1 - range(t, 14.0, 14.3)), k = spring(t, 12.6, 10);
  if (o <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: -40, right: -40, top: -120, bottom: -40, borderRadius: 40, opacity: o, transform: `scale(${1.04 - 0.04 * k})`, background: '#0a0c0a', boxShadow: '0 0 0 2px rgba(255,255,255,.1), 0 60px 160px rgba(0,0,0,.8)' }}>
      <div style={{ height: 80, display: 'flex', alignItems: 'center', gap: 16, padding: '0 34px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 24, height: 24, borderRadius: 12, background: c }} />)}
        <div style={{ flex: 1, textAlign: 'center', marginRight: 110, fontFamily: SANS, fontWeight: 600, fontSize: 28, color: 'rgba(238,243,238,.7)' }}>Eli</div>
      </div>
    </div>
  );
}

function Hero({ t, f }) {
  const { s, x, y } = heroCamera(t), c = crt(t), theme = heroTheme(t);
  const switched = t >= B.THEMES && t < B.ASK ? (t - B.THEMES) % THEME_DUR : 1;
  const glitch = switched < 0.05 ? (1 - switched / 0.05) : 0;
  const fadeOut = 1 - range(t, B.WALL - 0.02, B.WALL);
  return (
    <>
      {t >= 0.5 && t < 1.0 && Math.floor(t * 30) % 3 !== 1 && (
        <div style={{ position: 'absolute', left: 960 - 16, top: 540 - 16, width: 32, height: 32, background: GREEN, boxShadow: `0 0 30px ${GREEN}, 0 0 80px ${GREEN}` }} />
      )}
      <div style={{ position: 'absolute', left: 160, top: 140, width: 1600, height: 800, transform: `translate(${x + glitch * 14}px, ${y}px) scale(${s})`, opacity: fadeOut, filter: glitch ? `brightness(${1 + glitch})` : 'none' }}>
        <MacWindow t={t} />
        {c.on && (
          <div style={{ position: 'absolute', inset: 0, clipPath: c.clip }}>
            <FaceCanvas theme={theme} w={1600} h={800} f={f} crisp={theme !== 'trait-neon' && theme !== 'trait-doux'} />
            {c.flash > 0 && <div style={{ position: 'absolute', inset: 0, background: '#c8ffd9', opacity: c.flash, mixBlendMode: 'screen' }} />}
          </div>
        )}
      </div>
      {t > 1.6 && t < B.WAKE + 0.3 && <Zzz t={t} opacity={range(t, 2.2, 3.2) * (1 - range(t, B.WAKE, B.WAKE + 0.2))} />}
    </>
  );
}

function Opening({ t }) {
  if (t < 2.8 || t > 6) return null;
  const o = 1 - range(t, 5.3, 5.8);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 220, paddingBottom: 56, boxSizing: 'border-box', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', opacity: o, background: 'linear-gradient(transparent, rgba(0,0,0,.85) 70%)' }}>
      <Reveal text="8,192 pixels." t={t} t0={2.9} size={46} weight={600} color={INK} stagger={0.045} />
    </div>
  );
}

function Meet({ t }) {
  if (t < 10 || t > 14.4) return null;
  const out = 1 - range(t, 13.95, 14.3);
  return (
    <div style={{ position: 'absolute', left: 1100, top: 360, opacity: out, filter: out < 1 ? `blur(${(1 - out) * 16}px)` : 'none' }}>
      <Reveal text="Meet Eli." t={t} t0={10.2} size={150} stagger={0.05} tracking={-0.045} />
      <Reveal text="A face for your LLM." t={t} t0={11.0} size={46} weight={500} color={DIM} stagger={0.018} tracking={-0.01} style={{ marginTop: 34 }} />
      <Typed text="talks · listens · sings · sleeps" t={t} t0={11.8} size={26} style={{ marginTop: 30 }} />
    </div>
  );
}

function MoodWord({ t }) {
  if (t < B.MOODS || t >= B.THEMES) return null;
  const i = Math.floor((t - B.MOODS) / BEAT), u = (t - B.MOODS) % BEAT, k = expoOut(u / 0.25);
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: SANS, fontWeight: 800, fontSize: 290, letterSpacing: '-0.04em', color: 'transparent', WebkitTextStroke: `2px rgba(70,255,134,${0.42 * k})`, transform: `scale(${1.12 - 0.12 * k})` }}>
        {MOOD_SEQ[i][1]}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 70, textAlign: 'center', fontFamily: MONO, fontSize: 26, color: GREEN, opacity: 0.85 }}>
        [{MOOD_SEQ[i][1].toLowerCase()}]
      </div>
      <div style={{ position: 'absolute', left: 90, top: 80, opacity: 1 - range(t, 17.6, 18) }}>
        <Reveal text="It feels." t={t} t0={B.MOODS + 0.05} size={64} stagger={0.04} />
      </div>
    </>
  );
}

function ThemeLabel({ t }) {
  if (t < B.THEMES || t >= B.ASK) return null;
  const i = Math.floor((t - B.THEMES) / THEME_DUR), [, name, note] = THEME_SEQ[i], k = expoOut(((t - B.THEMES) % THEME_DUR) / 0.2);
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, textAlign: 'center', transform: `translateY(${(1 - k) * 16}px)`, opacity: k }}>
        <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 52, letterSpacing: '-0.02em', color: INK }}>{name}</div>
        <div style={{ fontFamily: MONO, fontSize: 22, color: DIM, marginTop: 10 }}>{note}</div>
      </div>
      <div style={{ position: 'absolute', left: 90, top: 80 }}>
        <Reveal text="Wears many faces." t={t} t0={B.THEMES + 0.05} size={64} stagger={0.03} />
      </div>
    </>
  );
}

// Lyrics the way the app shows them: the line being sung fills with Eli's ink as the syllables pass.
const WORDS = SONG.map((n) => ({ ...n, join: n.s === 'tle' || n.s === 'ery' }));
function Lyrics({ t }) {
  if (t < B.DROP || t >= B.WALL) return null;
  const lines = score.lines, found = lines.findIndex(([, b]) => t < WORDS[b - 1].t + WORDS[b - 1].d + 0.3);
  const li = found === -1 ? lines.length - 1 : found, [a, b] = lines[li], next = lines[li + 1];
  const o = range(t, B.DROP + 0.1, B.DROP + 0.4) * (1 - range(t, 33.6, 33.95));
  const render = (from, to, size, live) => WORDS.slice(from, to).map((w, i) => {
    const fill = live ? clamp((t - w.t) / Math.max(0.12, w.d * 0.8)) : 0;
    return (
      <span key={i} style={{ marginLeft: w.join || i === 0 ? 0 : '0.28em', position: 'relative', display: 'inline-block' }}>
        <span style={{ color: 'rgba(238,243,238,.32)' }}>{w.s}</span>
        <span style={{ position: 'absolute', left: 0, top: 0, color: GREEN, clipPath: `inset(0 ${(1 - fill) * 100}% 0 0)`, textShadow: `0 0 24px ${GREEN}88` }}>{w.s}</span>
      </span>
    );
  });
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 74, textAlign: 'center', opacity: o, fontFamily: SANS, letterSpacing: '-0.02em' }}>
      <div style={{ fontSize: 62, fontWeight: 700 }}>{render(a, b, 62, true)}</div>
      {next && <div style={{ fontSize: 34, fontWeight: 600, marginTop: 14, opacity: 0.7 }}>{render(next[0], next[1], 34, false)}</div>}
    </div>
  );
}

function SingChrome({ t }) {
  if (t < B.DROP || t >= B.WALL) return null;
  const bar = clamp(Math.floor((t - B.DROP) / 2), 0, 4), k = expoOut(((t - B.DROP) % 2) / 0.35);
  return (
    <>
      <div style={{ position: 'absolute', left: 90, top: 80 }}>
        <Reveal text="It sings." t={t} t0={B.DROP + 0.02} size={64} stagger={0.04} />
      </div>
      <div style={{ position: 'absolute', right: 84, top: 74, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 22px', borderRadius: 40, border: '1.5px solid rgba(70,255,134,.4)', background: 'rgba(70,255,134,.06)', fontFamily: MONO, fontSize: 24 }}>
        <span style={{ color: DIM }}>GENRE</span>
        <span style={{ color: GREEN, display: 'inline-block', transform: `translateY(${(1 - k) * 18}px)`, opacity: k }}>{BARS[bar][2]}</span>
      </div>
      <div style={{ position: 'absolute', right: 90, top: 140, fontFamily: MONO, fontSize: 20, color: DIM }}>the outfit follows the song</div>
    </>
  );
}

// 14 faces, one state: the camera pulls out of the last bar's face into the whole family.
const WALL = ['pixel', 'blocs', 'perles', 'perles-fond', 'grille', 'trait', 'trait-contour', 'trait-doux', 'trait-neon', 'chat-pixel', 'chat-perles', 'chaton', 'matrice', 'oscillo'];
const NAMES = { pixel: 'Pixel', blocs: 'Blocks', perles: 'Beads', 'perles-fond': 'Lit beads', grille: 'Custom', trait: 'Line', 'trait-contour': 'Outline', 'trait-doux': 'Soft', 'trait-neon': 'Neon', 'chat-pixel': 'Pixel cat', 'chat-perles': 'Bead cat', chaton: 'Kitten', matrice: 'Matrix', oscillo: 'Oscillo' };
function Wall({ t, f }) {
  const TW = 330, TH = 200, GAP = 22;
  const z = 1 - easeInOut(range(t, B.WALL, B.WALL + 1.7)), s = 1 + z * 2.6;
  const out = 1 - range(t, 39.55, 40);
  const pos = (i) => { // 5 + 5 + 4, the last row centered; "Soft" (index 7) sits in the middle
    const row = i < 5 ? 0 : i < 10 ? 1 : 2, col = row < 2 ? i % 5 : i - 10, n = row < 2 ? 5 : 4;
    return [960 + (col - (n - 1) / 2) * (TW + GAP), 520 + (row - 1) * (TH + GAP)];
  };
  const [cx, cy] = pos(7);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out, transform: `scale(${s * (1 - 0.04 * (1 - out))})`, transformOrigin: `${cx}px ${cy}px` }}>
      {WALL.map((id, i) => {
        const [x, y] = pos(i), lab = range(t, 35.3 + i * 0.03, 35.7 + i * 0.03);
        return (
          <div key={id} style={{ position: 'absolute', left: x - TW / 2, top: y - TH / 2, width: TW, height: TH, borderRadius: 22, background: '#000', boxShadow: `inset 0 0 0 1px rgba(255,255,255,${0.09 * (1 - z)})`, overflow: 'hidden' }}>
            <FaceCanvas theme={id} w={TW * 2} h={(TH - 40) * 2} f={f} glow={0.8} crisp={!id.startsWith('trait') && id !== 'chaton' && id !== 'oscillo'} style={{ transform: 'scale(.5)', transformOrigin: '0 0', marginTop: 6 }} />
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 10, textAlign: 'center', fontFamily: MONO, fontSize: 17, color: DIM, opacity: lab }}>{NAMES[id]}</div>
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 70, textAlign: 'center', display: 'flex', justifyContent: 'center', gap: 22, alignItems: 'baseline' }}>
        <Reveal text="14 faces." t={t} t0={36.4} size={72} stagger={0.04} />
        <Reveal text="So far." t={t} t0={36.9} size={72} weight={600} color={DIM} stagger={0.03} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, textAlign: 'center' }}>
        <Reveal text="A community catalog. Draw the next one." t={t} t0={37.6} size={44} weight={600} color={GREEN} stagger={0.015} tracking={-0.015} />
      </div>
    </div>
  );
}

function Devices({ t, f }) {
  const enter = (t0) => { const k = bounce(t, t0, 11, 0.62); return { opacity: range(t, t0, t0 + 0.25), transform: `translateY(${(1 - k) * 120}px)`, filter: k < 0.97 ? `blur(${(1 - Math.min(1, k)) * 20}px)` : 'none' } };
  const lift = easeInOut(range(t, 43.3, 43.9)), out = 1 - range(t, 45.6, 46);
  const label = (txt, sub, t0) => (
    <div style={{ textAlign: 'center', marginTop: 34, opacity: range(t, t0, t0 + 0.3) * (1 - lift) }}>
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 34, color: INK }}>{txt}</div>
      <div style={{ fontFamily: MONO, fontSize: 19, color: DIM, marginTop: 8 }}>{sub}</div>
    </div>
  );
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150 - 40 * lift, display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: 90, transform: `scale(${1 - 0.1 * lift})` }}>
        <div style={enter(40.45)}><Esp32 f={f} />{label('ESP32', 'the next home, soon', 41.2)}</div>
        <div style={enter(40.05)}><MacBook f={f} />{label('Mac', 'native app, signed', 40.9)}</div>
        <div style={enter(40.85)}><IPhone f={f} />{label('iPhone', 'in your pocket', 41.5)}</div>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 110, display: 'flex', justifyContent: 'center', gap: 26 }}>
        {['Local-first.', 'Open source.', 'MIT.'].map((w, i) => <Reveal key={w} text={w} t={t} t0={43.7 + i * 0.35} size={64} weight={i === 2 ? 800 : 700} color={i === 2 ? GREEN : INK} stagger={0.03} />)}
      </div>
    </div>
  );
}

// The end: he says good night, his eyes close, and everything drifts off with the music. No power-off snap.
function Finale({ t, f }) {
  const pop = bounce(t, B.FINALE, 9, 0.45), out = 1 - easeInOut(range(t, B.OFF + 0.4, B.LEN - 0.3));
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: out }}>
      <div style={{ position: 'absolute', left: 160, top: 140, width: 1600, height: 800, transform: `translateY(-170px) scale(${0.18 + 0.4 * pop})` }}>
        <FaceCanvas theme="pixel" w={1600} h={800} f={f} crisp />
      </div>
      {t > 49.9 && <div style={{ position: 'absolute', left: 1180, top: -10 }}><Zzz t={t} opacity={range(t, 50.1, 50.9)} /></div>}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 600, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Reveal text="Eli" t={t} t0={46.45} size={210} weight={800} tracking={-0.06} stagger={0.08} />
        <Reveal text="A face for your LLM." t={t} t0={47.1} size={48} weight={500} color={DIM} stagger={0.02} tracking={-0.01} style={{ marginTop: 18 }} />
        <Reveal text="Free and open source. Find it on GitHub: adrbn/eli" t={t} t0={47.9} size={34} weight={600} color={GREEN} stagger={0.008} tracking={-0.005} style={{ marginTop: 46 }} />
      </div>
    </div>
  );
}

function Flash({ t }) {
  const v = Math.max(0.3 * pulse(t, [B.WAKE], 9), 0.9 * pulse(t, [B.DROP], 7), 0.6 * pulse(t, [B.FINALE], 8));
  return v > 0.01 ? <div style={{ position: 'absolute', inset: 0, background: '#dfffe9', opacity: v }} /> : null;
}

export function Trailer() {
  const t = useCurrentFrame() / FPS, f = faceAt(t);
  const energy = t < B.MOODS ? 0.4 : t < B.FINALE ? 0.6 + 0.5 * beatPulse(t, B.MOODS, B.FINALE, 6) : 0.5;
  return (
    <AbsoluteFill style={{ background: '#000', fontFamily: SANS, color: INK, overflow: 'hidden' }}>
      <Audio src={staticFile('score.wav')} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 55% 50% at 50% 48%, rgba(70,255,134,${0.07 * energy}), transparent 70%)` }} />
      <MoodWord t={t} />
      {t < B.WALL && <Hero t={t} f={f} />}
      <Opening t={t} />
      <Meet t={t} />
      <ThemeLabel t={t} />
      <SingChrome t={t} />
      <Lyrics t={t} />
      {t >= B.WALL && t < B.DEVICES && <Wall t={t} f={f} />}
      {t >= B.DEVICES && t < B.FINALE && <Devices t={t} f={f} />}
      {t >= B.FINALE && <Finale t={t} f={f} />}
      <Flash t={t} />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 80% 75% at 50% 50%, transparent 60%, rgba(0,0,0,.55))', pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
}

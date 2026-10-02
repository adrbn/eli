// Le comportement du visage : regard, clignements, humeurs. Il ne dessine rien : chaque thème
// reçoit le même état { eyes, mouth } et le rend à sa façon (et l'ESP32 recevra ce même état).
//
// Le regard suit ce qu'on sait de la conversation : on détourne les yeux en commençant une phrase,
// on revient sur l'autre en la finissant (on lui rend la parole), on cligne dans les pauses.
// Sans capteur, des yeux au centre regardent tout le monde à la fois (effet Joconde).
export const REST = { o: 0, w: 0.3, r: 0, t: 0 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const WARM = 0.55; // sans humeur annoncée, les yeux sourient un peu : il est content d'être là
const DROWSY_AFTER = 120; // s sans rien → somnole, puis s'endort une minute plus tard
export const BREATH = 4.5; // s par respiration endormie (le ronflement s'y cale)
const bell = (u) => Math.sin(Math.PI * clamp(u, 0, 1));

// Les émotions que le LLM annonce par phrase ([joie]…) : des cibles pour les yeux (hap = sourire des yeux,
// sc = taille, sq = plissement, ang = paupières en colère > 0 / tristes < 0, ty = regard), et une bouche au repos.
export const MOODS = {
  joie: { hap: 0.85, sc: 1.06, rest: { o: 0.04, w: 0.75, r: 0, t: 0 } },
  rire: { hap: 1, sc: 1.04, bounce: 0.5, rest: { o: 0.3, w: 0.7, r: 0.1, t: 1 } },
  surprise: { sc: 1.25, sq: 0, rest: { o: 0.4, w: 0.15, r: 1, t: 0 } },
  tristesse: { sc: 0.94, sq: 0.25, ang: -0.9, ty: 0.35, rest: { o: 0.03, w: 0.15, r: 0.4, t: 0 } },
  colère: { sc: 0.95, sq: 0.3, ang: 1, rest: { o: 0.05, w: 0.45, r: 0, t: 1 } },
  amour: { hap: 0.75, sc: 1.08, pulse: 0.07, rest: { o: 0.03, w: 0.5, r: 0.3, t: 0 } },
  malice: { hap: 0.6, sq: 0.15, tx: 0.45, ty: -0.1, rest: { o: 0.03, w: 0.55, r: 0, t: 0 } }, // sans paupières en colère : ça lisait « vénère »
  gêne: { hap: 0.35, sc: 0.93, ty: 0.3, tx: -0.6, rest: { o: 0.02, w: 0.2, r: 0.2, t: 0 } },
};

// Les gestes spontanés, quand personne ne bouge : [nom, durée s, poids]. Le poids peut dépendre de la somnolence.
const GESTURES = [
  ['glance', 2.2, () => 4], ['lookaround', 3, () => 2], ['doubleblink', 0.6, () => 3], ['smile', 2.4, () => 4],
  ['curious', 1.6, () => 2], ['hum', 3.5, () => 1.5], ['sigh', 1.8, () => 1],
  ['yawn', 3, (drowsy, idle) => (idle > 50 ? 1.5 : 0) + 8 * drowsy], ['meow', 0.1, (d, i, cat) => (cat ? 1.2 : 0)],
];

export class Face {
  constructor() {
    this.e = { gx: 0, gy: 0, tx: 0, ty: 0, bl: 0, bt: 0, nb: 1.5, hap: 0, sc: 1, bo: 0, sa: 0, av: 0, sq: 0, sleep: 0, ang: 0, cl: 0, tn: 0, shut: 0, cool: 0 };
    this.mood = null; // une clé de MOODS, posée par la page pendant la phrase qui la porte
    this.m = { ...REST };
    this.T = 0;
    this.idle = 0;
    this.cat = false; // un visage de chat : il miaule parfois tout seul
    this.g = null; // geste en cours { name, t, dur, side }
    this.nextG = 5;
    this.forced = false; // endormi sur commande : ni la souris ni le serveur ne le réveillent
    this.groggy = false; // réveil doux en cours : les yeux s'ouvrent lentement, puis il bâille
  }

  sleep() {
    this.forced = true;
    this.g = null;
  }

  blink() {
    this.e.bt = 0.17;
    this.e.nb = 2.2 + Math.random() * 3.8;
  }

  // soft : un simple signe de vie (souris, serveur au repos), qui ne tire pas d'un sommeil commandé.
  wake(soft = false) {
    if (this.forced) {
      if (soft) return;
      this.forced = false;
      this.groggy = true;
    } else if (this.e.sleep > 0.3) { // réveillé en sursaut : grands yeux, puis ça retombe
      this.blink();
      this.e.sc = 1.3;
    }
    this.idle = 0;
    this.g = null;
  }

  pickGesture(drowsy) {
    const w = GESTURES.map(([, , weight]) => weight(drowsy, this.idle, this.cat));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    const i = w.findIndex((x) => (r -= x) < 0);
    const [name, dur] = GESTURES[Math.max(0, i)];
    this.g = { name, t: 0, dur: dur * (0.85 + Math.random() * 0.35), side: Math.random() < 0.5 ? -1 : 1 };
    this.nextG = 5 + Math.random() * 11 - drowsy * 3;
    if (name === 'doubleblink') this.blink();
    return name;
  }

  // Le geste en cours pousse le regard, l'humeur et la bouche ; rend la bouche voulue (ou null).
  gesture(dt) {
    const e = this.e, g = this.g, u = g.t / g.dur, side = g.side;
    g.t += dt;
    if (g.t >= g.dur) this.g = null;
    e.av = 0.2; // pas de saccade par-dessus
    switch (g.name) {
      case 'glance': e.tx = side * 1.05; e.ty = -0.15; return null;
      case 'lookaround': e.tx = u < 0.33 ? -side : u < 0.66 ? side : 0; e.ty = u < 0.66 ? -0.2 : 0; return null;
      case 'doubleblink': if (g.t > 0.3 && g.t - dt <= 0.3) this.blink(); return null;
      case 'smile': e.hap = Math.max(e.hap, bell(u)); return { o: 0.04, w: 0.3 + 0.6 * bell(u), r: 0, t: 0 };
      case 'curious': e.sc = Math.max(e.sc, 1 + 0.18 * bell(u)); e.tx = side * 0.5; e.ty = -0.6; if (g.t < dt * 1.5) e.bo = 0.6; return null;
      case 'hum': e.hap = Math.max(e.hap, 0.6 * bell(u)); e.tx = 0.3 * Math.sin(this.T * 3); return { o: 0.08 + 0.1 * Math.abs(Math.sin(this.T * 7)), w: 0.35, r: 0.5, t: 0 };
      case 'sigh': e.sq = Math.max(e.sq, 0.5 * bell(u)); e.sc = Math.min(e.sc, 1 - 0.06 * bell(u)); e.ty = 0.25; return { o: 0.18 * bell(u * 1.4), w: 0.25, r: 0.6, t: 0 };
      case 'yawn':
        e.sq = Math.max(e.sq, 0.85 * bell(u * 1.1)); e.sc = Math.max(e.sc, 1 + 0.05 * bell(u)); e.ty = -0.25;
        if (this.g === null) this.blink();
        return { o: 0.95 * bell(u * 1.15) ** 0.7, w: 0.2, r: 0.35 * bell(u), t: 0 };
      default: return null;
    }
  }

  // s : { mode, mouth, gaze, phraseStart, pause, clipEnd, beat, sway, energy, vocal, micLevel }
  update(dt, s) {
    const e = this.e, m = this.m;
    this.T += dt;
    this.idle = s.mode === 'idle' ? this.idle + dt : 0;
    const drowsy = this.forced ? 1 : clamp((this.idle - DROWSY_AFTER) / 60, 0, 1);
    e.sleep = ease(e.sleep, drowsy, drowsy < e.sleep ? (this.groggy ? 0.35 : 6) : 0.8, dt);
    const asleep = e.sleep > 0.6;
    if (this.groggy && e.sleep < 0.35) { // les yeux à moitié ouverts : il bâille, puis finit de s'éveiller
      this.groggy = false;
      if (s.mode === 'idle') this.g = { name: 'yawn', t: 0, dur: 3.4, side: 1 };
    }
    let started = null, gm = null;
    if (s.mode === 'idle' && !asleep) {
      this.nextG -= dt;
      if (!this.g && this.nextG <= 0 && this.idle > 3) started = this.pickGesture(drowsy);
    } else this.g = null;

    if (s.clipEnd) { // fin de réplique : on rend la parole en regardant l'autre
      e.tx = 0;
      e.ty = 0;
      e.av = 0;
      if (Math.random() < 0.6) this.blink();
    }
    if (s.mode === 'speak') {
      if (s.phraseStart && Math.random() < 0.75) {
        e.tx = (Math.random() < 0.5 ? -1 : 1) * 0.6;
        e.ty = -0.45;
        e.av = 0.5 + Math.random() * 0.35;
      }
      if (s.pause && Math.random() < 0.4) this.blink();
      this.relax(dt, 1);
    } else if (s.mode === 'sing') {
      if (s.beat) e.bo = Math.max(e.bo, s.beat);
      // Comme un chanteur : la note monte, les yeux se plissent et montent ; elle descend, le regard plonge.
      const p = s.pitch || 0;
      e.tx = 0.4 * Math.sin(s.sway || 0);
      e.ty = -0.1 - 0.55 * p;
      e.av = 0;
      e.hap = ease(e.hap, s.vocal ? 0.85 - 0.35 * Math.max(0, p) : 1, 5, dt); // il chante content : les notes hautes plissent un peu
      e.sc = ease(e.sc, 1 + 0.06 * (s.energy || 0) + 0.05 * Math.max(0, -p), 6, dt);
      e.sq = ease(e.sq, 0.75 * Math.max(0, p), 6, dt);
      this.feel(dt, s);
    } else if (s.mode === 'listen') {
      this.relax(dt, 1.1 + 0.12 * (s.micLevel || 0));
      if (this.T % 3.2 < dt) e.bo = Math.max(e.bo, 0.45); // petits hochements
    } else if (s.mode === 'think') {
      e.tx = 0.5 * Math.sin(this.T * 1.3);
      e.ty = -0.55;
      e.av = 0.3;
      e.hap = ease(e.hap, 0, 6, dt);
      e.sc = ease(e.sc, 1, 4, dt);
      e.sq = ease(e.sq, 0.35, 4, dt);
    } else {
      this.relax(dt, 1);
      if (this.g) gm = this.gesture(dt);
    }

    if (s.mode !== 'sing' && s.mode !== 'think' && !asleep) this.saccade(dt, s.mode);
    if (!asleep) {
      e.nb -= dt;
      if (e.nb <= 0) this.blink();
    }
    if (e.bt > 0) {
      e.bt -= dt;
      const q = 1 - Math.max(0, e.bt) / 0.17;
      e.bl = q < 0.4 ? q / 0.4 : 1 - (q - 0.4) / 0.6;
    } else e.bl = 0;
    e.bo *= Math.exp(-dt * 7);

    if (s.mode !== 'sing') this.feel(dt, null);
    const md = !asleep && MOODS[this.mood];
    e.ang = ease(e.ang, md?.ang || (e.cl > 0.3 ? -0.35 * e.cl : 0), 6, dt);
    if (md?.bounce && this.T % 0.32 < dt) e.bo = Math.max(e.bo, md.bounce); // rire : petits sursauts
    const pulse = md?.pulse ? md.pulse * Math.max(0, Math.sin(this.T * 7.5)) ** 8 : 0; // amour : un cœur qui bat

    const phase = (this.T / BREATH) % 1, inhale = asleep && phase < 0.4 ? bell(phase / 0.4) : 0;
    const want = gm || (asleep ? { o: 0.05 + 0.17 * inhale, w: 0.25, r: 0.4, t: 0 } : md?.rest || REST);
    if (s.mouth && s.mode === 'sing' && s.pitch) { // aigu : bouche plus haute et ronde ; grave : plus large
      const p = s.pitch;
      Object.assign(m, s.mouth, { o: Math.min(1, s.mouth.o * (1 + 0.3 * Math.max(0, p))), r: Math.min(1, s.mouth.r + 0.3 * Math.max(0, p)), w: Math.min(1, s.mouth.w + 0.25 * Math.max(0, -p)) });
    } else if (s.mouth && md) { // en parlant, l'émotion tire la bouche : plus large de joie, plus ronde de surprise
      Object.assign(m, s.mouth, { w: clamp(s.mouth.w + (md.rest.w - 0.3) * 0.5, 0, 1), r: clamp(s.mouth.r + md.rest.r * 0.3, 0, 1) });
    } else if (s.mouth) Object.assign(m, s.mouth);
    else for (const k in REST) m[k] = ease(m[k], want[k], gm ? 12 : 20, dt);

    const g = s.gaze || { x: 0, y: 0 }, gk = s.mode === 'sing' ? 8 : 20;
    e.gx = ease(e.gx, clamp(g.x + e.tx + (md?.tx || 0), -1.3, 1.3), gk, dt);
    e.gy = ease(e.gy, clamp(g.y + e.ty + (md?.ty || 0) + e.sleep * 0.3, -1, 1), gk, dt);
    const breathe = asleep ? 0.03 * inhale : 0.008 * Math.sin(this.T * 1.6); // éveillé, il respire à peine
    return {
      T: this.T,
      gesture: started,
      asleep,
      phase,
      eyes: { gx: e.gx, gy: e.gy, open: (1 - e.bl * 0.93) * (1 - e.sq * 0.4) * (1 - e.sleep * 0.9) * (1 - e.cl * 0.9), hap: e.hap, sc: e.sc + breathe + pulse, bo: e.bo, ang: e.ang },
      mouth: { ...m },
    };
  }

  // Les moments forts : sur une note tenue, aiguë et puissante (ou un sommet du morceau sans voix isolée), il ferme
  // les yeux comme un chanteur qui la vit, puis les rouvre ; jamais plus de 3,5 s, et pas deux fois de suite.
  feel(dt, s) {
    const e = this.e, p = s?.pitch || 0, o = s?.mouth?.o || 0, en = s?.energy || 0;
    const strain = s && (s.vocal ? en > 0.8 && o > 0.35 && p > 0.15 : en > 0.93);
    e.cool -= dt;
    e.tn = strain ? e.tn + dt : Math.max(0, e.tn - 2 * dt);
    if (e.shut > 0) {
      e.shut += dt;
      if (!strain && e.tn < 0.2 || e.shut > 3.5) { e.shut = 0; e.cool = 5 }
    } else if (e.tn > 0.45 && e.cool <= 0) e.shut = dt;
    e.cl = ease(e.cl, e.shut > 0 ? 1 : 0, e.shut > 0 ? 9 : 5, dt);
    if (e.cl > 0.3) e.ty = Math.min(e.ty, -0.35); // la tête un peu levée
  }

  relax(dt, scale) {
    const e = this.e, md = MOODS[this.mood] || {};
    e.hap = ease(e.hap, this.mood ? md.hap || 0 : WARM, 6, dt);
    e.sc = ease(e.sc, scale * (md.sc || 1), 6, dt);
    e.sq = ease(e.sq, md.sq || 0, 6, dt);
  }

  saccade(dt, mode) {
    const e = this.e;
    e.av -= dt;
    e.sa -= dt;
    if (e.av > 0 || e.sa > 0) return;
    const amp = mode === 'listen' ? 0.18 : mode === 'idle' ? 0.5 : 0.3;
    e.tx = (Math.random() - 0.5) * amp;
    e.ty = (Math.random() - 0.5) * amp * 0.6;
    e.sa = mode === 'listen' ? 0.9 + Math.random() * 1.1 : mode === 'idle' ? 0.8 + Math.random() * 2.5 : 0.35 + Math.random() * 1.1;
  }
}

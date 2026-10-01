// Les tenues d'Eli quand il chante : un accessoire, un décor et une couleur selon le genre du morceau (le serveur
// le détecte, voir server/genre.py), plus les notes qui s'échappent de sa bouche sur les temps forts.
// Tout se dessine dans le repère du visage pixel (x ∈ [0, 2], y ∈ [0, 1]) à partir de quelques repères (yeux, sommet
// de la tête) : chaque thème donne ses repères et sa mise à l'échelle, et les visages pixel le pixelisent (Mask).
const TAU = 2 * Math.PI;

export const GREEN = '#46ff86';
export const LOOKS = {
  tropical: { name: 'Tropical', color: '#4ff0dc', acc: 'shades', scene: 'palms' },
  electro: { name: 'Électro', color: '#ff5ae0', acc: 'shutters', scene: 'lasers' },
  rock: { name: 'Rock', color: '#ff5a46', acc: 'mohawk', scene: 'bolts' },
  rap: { name: 'Rap', color: '#ffd23c', acc: 'cap', scene: null },
  jazz: { name: 'Jazz', color: '#64aaff', acc: 'beret', scene: null },
  classique: { name: 'Classique', color: '#f0ecd2', acc: 'monocle', scene: null },
  country: { name: 'Country', color: '#ffa03c', acc: 'stetson', scene: 'cactus' },
  chill: { name: 'Chill', color: '#b4a0ff', acc: 'phones', scene: 'moon' },
  pop: { name: 'Pop', color: GREEN, acc: 'phones', scene: null },
};

// Repères du visage pixel (pixLit) et du chat (catLit), dans le repère 2:1.
export function pixAnchors(f) {
  const { gx, gy, sc, bo } = f.eyes, ey = 0.38 + gy * 0.1 - bo * 0.0625, eh = 0.24 * sc;
  return { ex: [0.6 + gx * 0.125, 1.4 + gx * 0.125], ey, ew: 0.2 * sc, eh, crown: ey - eh - 0.02, hw: 0.82 };
}
export function catAnchors(f) {
  const { gx, gy, sc, bo } = f.eyes, ey = 0.55 + gy * 0.05;
  return { ex: [0.75 + gx * 0.06, 1.25 + gx * 0.06], ey, ew: 0.12 * sc, eh: 0.12 * sc, crown: 0.2 - bo * 0.04, hw: 0.64 };
}

// Les notes : nées sur les temps forts près de la bouche, elles montent en s'écartant puis s'effacent.
export class Notes {
  constructor() { this.list = [] }

  update(dt, singing, beat) {
    // Peu nombreuses, et nées sur les joues, hors du visage : elles montent sur les bords sans passer devant les yeux.
    if (singing && beat > 0.7 && this.list.length < 3 && Math.random() < 0.45) {
      const dir = (this.side = -(this.side || 1));
      this.list.push({ x: 1 + dir * (0.74 + Math.random() * 0.06), y: 0.82, dir, age: 0, life: 1.8 + Math.random() * 0.6, two: Math.random() < 0.3, ph: Math.random() * TAU });
    }
    for (const n of this.list) {
      n.age += dt;
      n.x += n.dir * 0.06 * dt;
      n.y -= 0.26 * dt;
    }
    this.list = this.list.filter((n) => n.age < n.life && n.y > -0.2);
    return this.list;
  }
}

// Le décor seul (palmiers, lasers…), à part : il passe derrière le visage.
export function drawScene(ctx, f, look, on, off, alpha = 0.5) {
  const L = LOOKS[look];
  if (!L?.scene) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;
  SCENES[L.scene](ctx, f, on, off);
  ctx.globalAlpha = 1;
}

// Dessine le décor, l'accessoire et les notes. ctx est déjà dans le repère 2:1 ; `on` allume, `off` éteint (les
// reflets d'un verre, la fente d'un bob). `look` : une clé de LOOKS, ou null. scene : la couleur du décor, null s'il
// est déjà dessiné (derrière le visage).
export function drawExtras(ctx, f, a, look, notes, on, off, scene = on) {
  const L = LOOKS[look];
  if (scene) drawScene(ctx, f, look, scene, off);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const n of notes || []) {
    ctx.globalAlpha = Math.min(1, (n.life - n.age) / 0.5, n.age / 0.15);
    note(ctx, n.x + 0.02 * Math.sin(n.age * 4 + n.ph), n.y, n.two, on);
  }
  ctx.globalAlpha = 1;
  if (L?.acc) ACCESSORIES[L.acc](ctx, a, on, off, f); // l'accessoire par-dessus les notes
}

function note(ctx, x, y, two, on) {
  ctx.save(); // petites : 60 % du dessin d'origine
  ctx.translate(x, y);
  ctx.scale(0.6, 0.6);
  ctx.translate(-x, -y);
  ctx.fillStyle = on;
  ctx.strokeStyle = on;
  ctx.lineWidth = 0.022;
  const heads = two ? [[x - 0.05, y + 0.02], [x + 0.06, y]] : [[x, y]];
  for (const [hx, hy] of heads) {
    ctx.beginPath();
    ctx.ellipse(hx, hy, 0.038, 0.028, -0.4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx + 0.032, hy);
    ctx.lineTo(hx + 0.032, hy - 0.15);
    ctx.stroke();
  }
  ctx.beginPath();
  if (two) { // les deux croches, reliées par leur barre
    ctx.moveTo(x - 0.018, y - 0.13);
    ctx.lineTo(x + 0.092, y - 0.15);
    ctx.lineWidth = 0.04;
  } else { // le crochet
    ctx.moveTo(x + 0.032, y - 0.15);
    ctx.quadraticCurveTo(x + 0.1, y - 0.1, x + 0.08, y - 0.04);
  }
  ctx.stroke();
  ctx.restore();
}

const fill = (ctx, color, path) => { ctx.fillStyle = color; ctx.beginPath(); path(); ctx.fill() };
const stroke = (ctx, color, width, path) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); path(); ctx.stroke() };

const ACCESSORIES = {
  shades(ctx, a, on, off) { // lunettes de soleil, avec un reflet en biais
    const y = a.ey - 0.03, w = a.ew * 2.5, h = a.eh * 1.25;
    for (const x of a.ex) {
      fill(ctx, on, () => ctx.roundRect(x - w / 2, y - h / 2, w, h, [h * 0.15, h * 0.15, h * 0.5, h * 0.5]));
      fill(ctx, off, () => { ctx.moveTo(x - w * 0.3, y + h * 0.1); ctx.lineTo(x - w * 0.1, y - h * 0.35); ctx.lineTo(x - w * 0.02, y - h * 0.35); ctx.lineTo(x - w * 0.22, y + h * 0.1) });
    }
    stroke(ctx, on, 0.04, () => {
      ctx.moveTo(a.ex[0] + w / 2, y - h * 0.3);
      ctx.lineTo(a.ex[1] - w / 2, y - h * 0.3);
      ctx.moveTo(a.ex[0] - w / 2, y - h * 0.3);
      ctx.lineTo(a.ex[0] - w / 2 - 0.12, y - h * 0.4);
      ctx.moveTo(a.ex[1] + w / 2, y - h * 0.3);
      ctx.lineTo(a.ex[1] + w / 2 + 0.12, y - h * 0.4);
    });
  },
  shutters(ctx, a, on, off) { // lunettes à persiennes
    const y = a.ey - 0.03, w = a.ew * 2.5, h = a.eh * 1.2;
    for (const x of a.ex) {
      stroke(ctx, on, 0.035, () => ctx.roundRect(x - w / 2, y - h / 2, w, h, h * 0.2));
      for (let k = 1; k < 4; k++) stroke(ctx, on, 0.03, () => { ctx.moveTo(x - w / 2, y - h / 2 + (k * h) / 4); ctx.lineTo(x + w / 2, y - h / 2 + (k * h) / 4) });
    }
    stroke(ctx, on, 0.035, () => { ctx.moveTo(a.ex[0] + w / 2, y - h * 0.3); ctx.lineTo(a.ex[1] - w / 2, y - h * 0.3) });
  },
  phones(ctx, a, on) { // un casque : l'arceau passe au-dessus des yeux sans les toucher, les écouteurs sur les côtés
    const cx = (a.ex[0] + a.ex[1]) / 2, x = a.hw + 0.08, top = Math.max(0.03, a.crown - 0.07), y = a.ey + 0.06, r = 0.16;
    stroke(ctx, on, 0.035, () => {
      ctx.moveTo(cx - x, y);
      ctx.arcTo(cx - x, top, cx, top, r);
      ctx.arcTo(cx + x, top, cx + x, y, r);
      ctx.lineTo(cx + x, y);
    });
    for (const s of [-1, 1]) fill(ctx, on, () => ctx.roundRect(cx + s * x - 0.06, y - 0.12, 0.12, 0.24, 0.05));
  },
  cap(ctx, a, on, off) { // casquette, visière sur le côté
    const cx = (a.ex[0] + a.ex[1]) / 2, y = a.crown, r = a.hw * 0.68;
    fill(ctx, on, () => ctx.ellipse(cx, y, r, 0.2, 0, Math.PI, TAU));
    fill(ctx, on, () => ctx.ellipse(cx + r * 0.95, y - 0.005, r * 0.55, 0.045, -0.08, 0, TAU));
    stroke(ctx, off, 0.02, () => { ctx.moveTo(cx - r * 0.9, y - 0.035); ctx.lineTo(cx + r * 0.9, y - 0.035) });
  },
  mohawk(ctx, a, on, off, f) { // crête punk, qui frémit sur les temps
    const cx = (a.ex[0] + a.ex[1]) / 2, y = a.crown + 0.03, lift = 0.05 * f.eyes.bo;
    fill(ctx, on, () => {
      ctx.moveTo(cx - 0.36, y);
      for (let k = 0; k < 5; k++) {
        const x = cx - 0.36 + (k + 0.5) * 0.144;
        ctx.lineTo(x, y - 0.2 - lift - (k === 2 ? 0.05 : 0));
        ctx.lineTo(x + 0.072, y);
      }
      ctx.closePath();
    });
  },
  beret(ctx, a, on) { // béret penché
    const cx = (a.ex[0] + a.ex[1]) / 2 - 0.08, y = a.crown;
    fill(ctx, on, () => ctx.ellipse(cx, y - 0.04, a.hw * 0.62, 0.11, -0.12, 0, TAU));
    stroke(ctx, on, 0.03, () => { ctx.moveTo(cx + 0.02, y - 0.14); ctx.lineTo(cx + 0.05, y - 0.2) });
  },
  monocle(ctx, a, on) { // monocle et sa chaînette
    const x = a.ex[1], y = a.ey, r = Math.max(a.ew, a.eh) * 1.18;
    stroke(ctx, on, 0.03, () => ctx.arc(x, y, r, 0, TAU));
    stroke(ctx, on, 0.016, () => { ctx.moveTo(x + r * 0.7, y + r * 0.7); ctx.quadraticCurveTo(x + r * 1.4, y + 0.45, x + r * 1.7, y + 0.62) });
  },
  stetson(ctx, a, on, off) { // chapeau de cow-boy
    const cx = (a.ex[0] + a.ex[1]) / 2, y = a.crown;
    fill(ctx, on, () => ctx.ellipse(cx, y, a.hw * 0.95, 0.05, 0, 0, TAU));
    fill(ctx, on, () => ctx.roundRect(cx - 0.3, y - 0.2, 0.6, 0.2, [0.12, 0.12, 0, 0]));
    fill(ctx, off, () => ctx.ellipse(cx, y - 0.2, 0.08, 0.04, 0, 0, TAU)); // le creux du dessus
    stroke(ctx, off, 0.02, () => { ctx.moveTo(cx - 0.3, y - 0.05); ctx.lineTo(cx + 0.3, y - 0.05) });
  },
};

const SCENES = {
  palms(ctx, f, on) { // deux palmiers qui se balancent, et la mer en bas
    for (const s of [-1, 1]) {
      const base = 1 + s * 0.84, sway = 0.035 * Math.sin(f.T * 1.4 + s), top = [base + s * 0.08 + sway, 0.2];
      stroke(ctx, on, 0.035, () => { ctx.moveTo(base, 1); ctx.quadraticCurveTo(base - s * 0.04, 0.55, ...top) });
      for (const ang of [-2.6, -2.0, -1.2, -0.5, 0.15]) {
        const dx = Math.cos(ang + sway * 2) * 0.17, dy = Math.sin(ang + sway * 2) * 0.12;
        stroke(ctx, on, 0.03, () => { ctx.moveTo(...top); ctx.quadraticCurveTo(top[0] + dx * 0.6, top[1] + dy - 0.06, top[0] + dx, top[1] + dy + 0.05) });
      }
    }
    stroke(ctx, on, 0.02, () => { for (let x = 0; x <= 2; x += 0.02) ctx.lineTo(x, 0.97 + 0.012 * Math.sin(x * 18 - f.T * 2)) });
  },
  lasers(ctx, f, on) { // des faisceaux qui balaient depuis les coins du haut
    for (const s of [-1, 1]) for (const k of [0, 1]) {
      const tx = 1 + s - s * (1.1 + 0.7 * Math.sin(f.T * (1.3 + k * 0.7) + k * 2));
      stroke(ctx, on, 0.012, () => { ctx.moveTo(1 + s, 0); ctx.lineTo(tx, 1.1) });
    }
  },
  bolts(ctx, f, on) { // des éclairs sur les temps forts
    if (f.eyes.bo < 0.25) return;
    for (const s of [-1, 1]) {
      const x = 1 + s * 0.86;
      fill(ctx, on, () => { ctx.moveTo(x + 0.04, 0.12); ctx.lineTo(x - 0.06, 0.48); ctx.lineTo(x + 0.01, 0.46); ctx.lineTo(x - 0.05, 0.85); ctx.lineTo(x + 0.08, 0.38); ctx.lineTo(x + 0.01, 0.4); ctx.lineTo(x + 0.08, 0.12) });
    }
  },
  cactus(ctx, f, on) { // un cactus de chaque côté
    for (const s of [-1, 1]) {
      const x = 1 + s * 0.86;
      stroke(ctx, on, 0.06, () => {
        ctx.moveTo(x, 1); ctx.lineTo(x, 0.5);
        ctx.moveTo(x, 0.78); ctx.lineTo(x - 0.08, 0.78); ctx.lineTo(x - 0.08, 0.64);
        ctx.moveTo(x, 0.7); ctx.lineTo(x + 0.08, 0.7); ctx.lineTo(x + 0.08, 0.58);
      });
    }
  },
  moon(ctx, f, on, off) { // un croissant de lune et des étoiles qui scintillent
    fill(ctx, on, () => { ctx.arc(0.22, 0.2, 0.1, 0, TAU) });
    fill(ctx, off, () => { ctx.arc(0.27, 0.16, 0.09, 0, TAU) });
    for (const [x, y, p] of [[1.8, 0.12, 0], [1.66, 0.3, 2], [1.86, 0.5, 4], [0.14, 0.62, 1]]) {
      if (Math.sin(f.T * 2 + p) > -0.3) fill(ctx, on, () => ctx.arc(x, y, 0.018, 0, TAU));
    }
  },
};

// Pixelisation pour les visages pixel : on dessine les extras sur une petite toile de cols×rows et on lit chaque case.
// at(i, j) > 0 : allumée (SCENE pour le décor, plus pâle et derrière le visage), < 0 : éteinte de force (un reflet),
// 0 : rien à dire. Chaque sorte a son canal : rouge = notes et accessoire, vert = décor, bleu = éteint.
export const SCENE = 0.5;
export class Mask {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.data = null;
  }

  // xf = [sx, ox, sy, oy] : case = repère 2:1 × s + o.
  render(f, a, look, notes, cols, rows, xf = [cols / 2, 0, rows, 0]) {
    this.data = null;
    if (!LOOKS[look] && !notes?.length) return this;
    const c = this.canvas, ctx = this.ctx;
    if (c.width !== cols || c.height !== rows) {
      c.width = cols;
      c.height = rows;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cols, rows);
    ctx.setTransform(xf[0], 0, 0, xf[2], xf[1], xf[3]);
    drawExtras(ctx, f, a, look, notes, '#ff0000', '#0000ff', '#00ff00');
    this.cols = cols;
    this.data = ctx.getImageData(0, 0, cols, rows).data;
    return this;
  }

  at(i, j) {
    if (!this.data) return 0;
    const k = (j * this.cols + i) * 4, r = this.data[k], g = this.data[k + 1], b = this.data[k + 2];
    return b > 110 ? -1 : r > 60 ? r / 255 : g > 60 ? SCENE : 0;
  }
}

// Le décor passe derrière le visage : une case de décor qui touche un trait allumé reste noire. Ce liseré d'une case
// sépare les lasers des yeux, même sur un OLED tout-ou-rien. face : les cases du visage (1 = allumée), cols×rows.
export function behind(face, cols, rows, i, j) {
  for (let b = Math.max(0, j - 1); b <= Math.min(rows - 1, j + 1); b++) {
    for (let a = Math.max(0, i - 1); a <= Math.min(cols - 1, i + 1); a++) if (face[b * cols + a]) return true;
  }
  return false;
}

// La couleur de l'encre, qui glisse vers celle de la tenue.
export function mixColor(from, to, k) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(from), b = p(to);
  const step = (v, i) => (Math.abs(b[i] - v) < 6 ? b[i] : Math.round(v + (b[i] - v) * k)); // sans traîner au bout
  return `#${a.map((v, i) => step(v, i).toString(16).padStart(2, '0')).join('')}`;
}

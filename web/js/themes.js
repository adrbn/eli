// Les visages. Tous dessinent le même état { T, eyes, mouth } venu de face.js : changer de thème ne change
// que le rendu, jamais le comportement. Famille Pixel : un écran OLED 128×64 simulé pixel par pixel, ou une
// matrice de LED (AMOLED). Famille Trait : du vectoriel pour écran rond. Sur l'ESP32, un thème = une fonction de dessin.
const G = '#46ff86', DIM = '#0e2a18', LIT = 0xff86ff46, OFF = 0xff000000; // couleurs en ABGR (little-endian)
const TAU = 2 * Math.PI;
const ease = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export const SCREENS = { rect: 2, round: 1, wide: 4 / 3 }; // largeur / hauteur

// Réglages du thème « Sur mesure », modifiés par l'interface.
let custom = { cols: 40, shape: 'perle', bg: true };
export const getCustom = () => custom;
export const setCustom = (next) => { custom = { ...custom, ...next } };

// Distance signée à un rectangle arrondi (négative dedans).
function sdBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

// Visage « pixel » dans un espace 2:1 (x ∈ [0, 2], y ∈ [0, 1]) : le point est-il allumé ?
// Yeux en rectangles très arrondis ; minH garde la bouche visible même sur une grille grossière.
function pixLit(f, x, y, minH) {
  const { gx, gy, open, hap, sc, bo, ang = 0 } = f.eyes, m = f.mouth;
  const hw = 0.2 * sc, hh = Math.max(0.03, 0.24 * sc * open), er = Math.min(hw, hh) * 0.6;
  for (const s of [-1, 1]) {
    const ex = 1 + s * 0.4 + gx * 0.125, ey = 0.38 + gy * 0.1 - bo * 0.0625;
    if (sdBox(x - ex, y - ey, hw, hh, er) > 0) continue;
    // Paupière inclinée : en colère, le coin intérieur descend ; triste, c'est le coin extérieur.
    const inner = clamp01((1 - s * (x - ex) / hw) / 2);
    if (ang && y - (ey - hh) < hh * (ang > 0 ? ang * 1.1 * inner : -ang * 0.9 * (1 - inner))) continue;
    const smile = hap > 0.05 && ((x - ex) / (1.3 * hw)) ** 2 + ((y - ey - 1.1 * hh) / (1.2 * hh * hap)) ** 2 <= 1;
    return !smile;
  }
  const mw = 0.075 + m.w * 0.09 - m.r * 0.045, mh = Math.max(minH, 0.022 + m.o * 0.075 + m.r * 0.012), dy = y - 0.82;
  if (sdBox(x - 1, dy, mw, mh, Math.min(mw, mh) * (0.7 + m.r * 0.3)) > 0) return false;
  return !(m.t > 0.5 && mh > 0.05 && Math.abs(dy) < 0.018); // les dents : une ligne éteinte au milieu
}

// Distance d'un point à un segment.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, k = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - ax - k * dx, py - ay - k * dy);
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const inTri = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by), d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy), d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

// Le chat, même espace 2:1 que pixLit, façon émoji : une tête ronde avec ses oreilles, de petits yeux ronds
// qui brillent, des joues roses en pointillés, une truffe, un « ω » qui s'ouvre en parlant, des moustaches.
const HEAD = { x: 1, y: 0.58, rx: 0.6, ry: 0.4 };
function catLit(f, x, y0, minH) {
  const { gx, gy, open, hap, sc, bo } = f.eyes, m = f.mouth, rows = Math.round(0.55 / minH);
  const y = y0 + bo * 0.04, line = Math.max(0.017, minH * 0.6);
  const head = Math.hypot((x - HEAD.x) / HEAD.rx, (y - HEAD.y) / HEAD.ry);
  if (Math.abs(head - 1) * Math.min(HEAD.rx, HEAD.ry) < line * 0.75) return true; // contour de la tête
  for (const s of [-1, 1]) {
    const twitch = (f.T + (s > 0 ? 3.1 : 0)) % 7.3 < 0.18 ? 0.03 : 0;
    const tip = [1 + s * (0.47 + twitch), 0.05 + twitch], inner = [1 + s * 0.16, 0.2], outer = [1 + s * 0.56, 0.37];
    if (head > 1 && (segDist(x, y, ...tip, ...inner) < line * 0.75 || segDist(x, y, ...tip, ...outer) < line * 0.75)) return true;
    if (head > 1.05 && inTri(x, y, [tip[0] - s * 0.01, tip[1] + 0.09], [inner[0] + s * 0.07, inner[1] + 0.01], [outer[0] - s * 0.04, outer[1] - 0.06])) {
      return (Math.floor((x / 2) * rows * 2) + Math.floor(y * rows)) % 2 === 0; // l'intérieur, en pointillés
    }
    const ex = 1 + s * 0.25 + gx * 0.06, ey = 0.55 + gy * 0.05, rx = 0.095 * sc, ry = Math.max(0.018, 0.12 * sc * open);
    if (hap > 0.5) {
      const d = Math.hypot((x - ex) / rx, (y - ey - 0.04) / (ry * 0.9));
      if (Math.abs(d - 1) < 0.35 && y < ey + 0.03) return true;
    } else if (((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 <= 1) {
      const px = ex + clamp01(0.5 + gx * 0.5) * rx * 0.9 - rx * 0.45, py = ey + clamp01(0.5 + gy * 0.5) * ry * 0.7 - ry * 0.45;
      return !(ry > 0.06 && Math.hypot(x - px, y - py) < Math.max(0.03, minH * 0.75)); // la pupille suit le regard
    }
    if (((x - 1 - s * 0.42) / 0.08) ** 2 + ((y - 0.72) / 0.045) ** 2 <= 1) { // joue rose : pointillés
      return (Math.floor((x / 2) * rows * 2) + Math.floor(y * rows)) % 2 === 0;
    }
    for (const k of [0, 1]) { // moustaches, qui dépassent de la tête
      if (segDist(x, y, 1 + s * 0.5, 0.66 + k * 0.07, 1 + s * 0.8, 0.6 + k * 0.12) < line * 0.5) return true;
    }
  }
  if (inTri(x, y, [0.97, 0.655], [1.03, 0.655], [1, 0.685])) return true; // truffe
  for (const s of [-1, 1]) { // « ω »
    const d = Math.hypot(x - 1 - s * 0.035, y - 0.71);
    if (y >= 0.705 && Math.abs(d - 0.035) < line * 0.55) return true;
  }
  if (m.o > 0.08) { // la bouche s'ouvre sous le « ω »
    const mw = 0.035 + m.w * 0.03 - m.r * 0.015, mh = Math.max(minH, 0.012 + m.o * 0.06);
    if (sdBox(x - 1, y - (0.745 + mh), mw, mh, Math.min(mw, mh) * 0.9) <= 0) return true;
  }
  return false;
}

// Écran OLED 128×64 monochrome : cols×rows cellules de `cell` pixels, `pattern` = pixels allumés par cellule.
function oled(cols, cell, pattern, lit = pixLit) {
  const rows = cols / 2, x0 = (128 - cols * cell) >> 1, y0 = (64 - rows * cell) >> 1, minH = 0.55 / rows;
  const off = document.createElement('canvas');
  off.width = 128;
  off.height = 64;
  const ox = off.getContext('2d'), img = ox.createImageData(128, 64), px = new Uint32Array(img.data.buffer);
  return (ctx, W, H, f) => {
    px.fill(OFF);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      if (!lit(f, ((i + 0.5) / cols) * 2, (j + 0.5) / rows, minH)) continue;
      for (const [a, b] of pattern) px[(y0 + j * cell + b) * 128 + x0 + i * cell + a] = LIT;
    }
    ox.putImageData(img, 0, 0);
    const s = Math.max(1, Math.floor(Math.min(W / 128, H / 64))), X = (W - 128 * s) >> 1, Y = (H - 64 * s) >> 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, X, Y, 128 * s, 64 * s);
    if (s < 4) return;
    ctx.fillStyle = 'rgba(0,0,0,.35)'; // l'espace noir entre les pixels physiques
    const lw = Math.max(1, Math.round(s * 0.12));
    for (let i = 0; i <= 128; i++) ctx.fillRect(X + i * s, Y, lw, 64 * s);
    for (let j = 0; j <= 64; j++) ctx.fillRect(X, Y + j * s, 128 * s, lw);
  };
}

// Matrice de LED couleur (AMOLED) : chaque point s'allume et s'éteint en fondu ; `bg` montre les LED éteintes.
function dots(opts, lit = pixLit) {
  let F = new Float32Array(0);
  return (ctx, W, H, f, dt) => {
    const { cols, shape, bg } = opts(), rows = cols / 2, minH = 0.55 / rows;
    if (F.length !== cols * rows) F = new Float32Array(cols * rows);
    const c = Math.min(W / cols, H / rows), X = (W - c * cols) / 2, Y = (H - c * rows) / 2;
    const dot = shape === 'perle'
      ? (x, y) => { ctx.moveTo(x + c * 0.9, y + c / 2); ctx.arc(x + c / 2, y + c / 2, c * 0.4, 0, TAU) }
      : (x, y) => ctx.roundRect(x + c * 0.08, y + c * 0.08, c * 0.84, c * 0.84, c * 0.18);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (bg) {
      ctx.fillStyle = DIM;
      ctx.beginPath();
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) dot(X + i * c, Y + j * c);
      ctx.fill();
    }
    ctx.fillStyle = G;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      F[k] = ease(F[k], lit(f, ((i + 0.5) / cols) * 2, (j + 0.5) / rows, minH) ? 1 : 0, 30, dt);
      if (F[k] < 0.02) continue;
      ctx.globalAlpha = F[k];
      ctx.beginPath();
      dot(X + i * c, Y + j * c);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
}

// Dessin vectoriel dans un repère fixe (w×h) mis à l'échelle de l'écran. `fade` > 0 : rémanence (oscilloscope).
function vector(w, h, draw, fade = 0) {
  return (ctx, W, H, f, dt) => {
    const s = Math.min(W / w, H / h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = fade ? `rgba(0,0,0,${1 - Math.exp(-dt * fade)})` : '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, (W - w * s) / 2, (H - h * s) / 2);
    ctx.fillStyle = G;
    ctx.strokeStyle = G;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    draw(ctx, f, s);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
}

// Trait d'origine : yeux ronds pleins, lèvres dessinées en deux courbes.
function traitClassic(ctx, f) {
  const { gx, gy, open, hap, sc, bo } = f.eyes, m = f.mouth;
  ctx.lineWidth = 3.5;
  for (const s of [-1, 1]) {
    const ex = 110 + s * 40 + gx * 12, ey = 88 + gy * 9 - bo * 7, r = 12 * sc;
    ctx.beginPath();
    if (hap > 0.5) {
      ctx.arc(ex, ey + 6, r, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      ctx.ellipse(ex, ey, r, Math.max(1.6, r * open), 0, 0, TAU);
      ctx.fill();
    }
  }
  const my = 148, hw = 25 + m.w * 14 - m.r * 14, up = m.o * 7 + m.r * 5, dn = m.o * 22 + m.r * 8, k = 0.5 + m.r * 0.42;
  ctx.beginPath();
  ctx.moveTo(110 - hw, my);
  ctx.bezierCurveTo(110 - hw * k, my + 3 - up * 1.4, 110 + hw * k, my + 3 - up * 1.4, 110 + hw, my);
  ctx.bezierCurveTo(110 + hw * k, my + 3 + dn * 1.3, 110 - hw * k, my + 3 + dn * 1.3, 110 - hw, my);
  ctx.closePath();
  ctx.stroke();
  if (m.t > 0.3) {
    ctx.globalAlpha = Math.min(1, m.t);
    ctx.beginPath();
    ctx.moveTo(110 - hw * 0.5, my + 2 - up * 0.4);
    ctx.lineTo(110 + hw * 0.5, my + 2 - up * 0.4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// Variantes « douces » : les yeux en rectangles très arrondis du Pixel, en vectoriel ; bouche en gélule.
function traitSoft(outline, glow) {
  return (ctx, f, s) => {
    const { gx, gy, open, hap, sc, bo } = f.eyes, m = f.mouth;
    ctx.lineWidth = glow ? 2.6 : 3.2;
    if (glow) {
      ctx.strokeStyle = '#d2ffe1';
      ctx.shadowColor = G;
      ctx.shadowBlur = 12 * s;
    }
    for (const side of [-1, 1]) {
      const ex = 110 + side * 42 + gx * 12, ey = 86 + gy * 9 - bo * 7, w = 34 * sc, h = Math.max(3, 40 * sc * open);
      ctx.beginPath();
      if (outline && hap > 0.5) {
        ctx.arc(ex, ey + 8, w * 0.5, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
        continue;
      }
      ctx.roundRect(ex - w / 2, ey - h / 2, w, h, Math.min(w, h) * 0.42);
      if (outline) {
        ctx.stroke();
        continue;
      }
      ctx.fill();
      if (hap > 0.05) { // yeux rieurs : on gomme le bas de l'œil
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(ex, ey + h * 0.55, w * 0.68, h * 0.6 * hap, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = G;
      }
    }
    const mw = 30 + m.w * 30 - m.r * 18, mh = Math.max(outline ? 3 : 5, 5 + m.o * 26 + m.r * 6), my = 152;
    ctx.beginPath();
    ctx.roundRect(110 - mw / 2, my - mh / 2, mw, mh, Math.min(mw, mh) / 2);
    if (outline) ctx.stroke();
    else ctx.fill();
    if (m.t > 0.4 && mh > 10) {
      if (outline) {
        ctx.beginPath();
        ctx.moveTo(110 - mw * 0.32, my);
        ctx.lineTo(110 + mw * 0.32, my);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(110 - mw * 0.36, my - 1.3, mw * 0.72, 2.6);
      }
    }
  };
}

// Chaton vectoriel pour écran rond : même dessin que le chat pixel, en traits doux, joues roses.
function kitten(ctx, f) {
  const { gx, gy, open, hap, sc, bo } = f.eyes, m = f.mouth, lift = bo * 6, cy = 128 - lift;
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.ellipse(110, cy, 80, 58, 0, 0, TAU);
  ctx.stroke();
  for (const s of [-1, 1]) {
    const twitch = (f.T + (s > 0 ? 3.1 : 0)) % 7.3 < 0.18 ? 5 : 0;
    ctx.beginPath(); // oreille
    ctx.moveTo(110 + s * 72, cy - 24);
    ctx.lineTo(110 + s * (62 + twitch), cy - 84 + twitch);
    ctx.lineTo(110 + s * 22, cy - 55);
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(110 + s * 63, cy - 36);
    ctx.lineTo(110 + s * (60 + twitch), cy - 70 + twitch);
    ctx.lineTo(110 + s * 36, cy - 52);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(110 + s * 50, cy + 18, 12, 7, 0, 0, TAU); // joue
    ctx.fill();
    ctx.globalAlpha = 1;
    const ex = 110 + s * 30 + gx * 8, ey = cy + gy * 6, rx = 11 * sc, ry = Math.max(2, 14 * sc * open);
    ctx.beginPath();
    if (hap > 0.5) {
      ctx.arc(ex, ey + 6, rx, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else {
      ctx.ellipse(ex, ey, rx, ry, 0, 0, TAU);
      ctx.fill();
      if (ry > 7) { // la pupille suit le regard
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(ex + Math.max(-1, Math.min(1, gx)) * 4.5, ey - ry * 0.15 + Math.max(-1, Math.min(1, gy)) * 5, 4.2, 0, TAU);
        ctx.fill();
        ctx.fillStyle = G;
      }
    }
    ctx.lineWidth = 2;
    for (const k of [0, 1]) { // moustaches
      ctx.beginPath();
      ctx.moveTo(110 + s * 62, cy + 10 + k * 9);
      ctx.lineTo(110 + s * 100, cy + 2 + k * 16);
      ctx.stroke();
    }
    ctx.lineWidth = 3.2;
  }
  ctx.beginPath(); // truffe
  ctx.roundRect(105, cy + 13, 10, 6, 3);
  ctx.fill();
  ctx.lineWidth = 2.4;
  ctx.beginPath(); // « ω »
  ctx.arc(104.5, cy + 22, 5.5, 0.15, Math.PI - 0.1);
  ctx.moveTo(121, cy + 22);
  ctx.arc(115.5, cy + 22, 5.5, 0.1, Math.PI - 0.15);
  ctx.stroke();
  if (m.o > 0.08) { // la bouche s'ouvre sous le « ω »
    const w = 6 + m.w * 5 - m.r * 3, h = 2 + m.o * 15;
    ctx.beginPath();
    ctx.moveTo(110 - w, cy + 28);
    ctx.quadraticCurveTo(110 - w, cy + 28 + h, 110, cy + 28 + h);
    ctx.quadraticCurveTo(110 + w, cy + 28 + h, 110 + w, cy + 28);
    ctx.closePath();
    ctx.fill();
  }
}

// Matrice ronde de 19×19 LED.
function matLit(f, u, v) {
  const { gx, gy, open, hap, sc, bo } = f.eyes, m = f.mouth;
  for (const s of [-1, 1]) {
    const ex = s * 0.37 + gx * 0.1, ey = -0.2 + gy * 0.08 - bo * 0.09, rx = 0.17 * sc, ry = Math.max(0.04, 0.23 * sc * open);
    if (hap > 0.5) {
      const d = Math.hypot((u - ex) / 0.18, (v - ey - 0.1) / 0.22);
      if (Math.abs(d - 1) < 0.38 && v < ey + 0.06) return 1;
    } else if (((u - ex) / rx) ** 2 + ((v - ey) / ry) ** 2 <= 1) return 1;
  }
  const my = 0.45, rx = 0.17 + m.w * 0.17 - m.r * 0.12, ry = 0.05 + m.o * 0.18 + m.r * 0.05;
  if ((u / rx) ** 2 + ((v - my) / ry) ** 2 > 1) return 0;
  if ((m.t > 0.5 && Math.abs(v - my) < 0.06) || ry < 0.12) return 1;
  return (u / (rx - 0.11)) ** 2 + ((v - my) / (ry - 0.11)) ** 2 > 1 ? 1 : 0; // bouche ouverte : seulement le contour
}

function matrice() {
  const N = 19, F = new Float32Array(N * N);
  return (ctx, W, H, f, dt) => {
    const c = Math.min(W, H) / N, X = (W - c * N) / 2, Y = (H - c * N) / 2;
    const each = (fn) => {
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const u = -1 + ((i + 0.5) * 2) / N, v = -1 + ((j + 0.5) * 2) / N;
        if (u * u + v * v <= 0.93) fn(j * N + i, X + (i + 0.5) * c, Y + (j + 0.5) * c, u, v);
      }
    };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = DIM;
    ctx.beginPath();
    each((k, x, y) => { ctx.moveTo(x + c * 0.36, y); ctx.arc(x, y, c * 0.36, 0, TAU) });
    ctx.fill();
    ctx.fillStyle = G;
    each((k, x, y, u, v) => {
      F[k] = ease(F[k], matLit(f, u, v), 30, dt);
      if (F[k] < 0.02) return;
      ctx.globalAlpha = F[k];
      ctx.beginPath();
      ctx.arc(x, y, c * 0.38, 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  };
}

// Oscilloscope : une trace qui vibre, avec rémanence.
function oscillo(ctx, f) {
  const { gx, gy, open, hap, sc, bo } = f.eyes, m = f.mouth, T = f.T, cx = 132, cy = 99;
  ctx.strokeStyle = 'rgba(70,255,134,.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 10; i++) { ctx.moveTo((i * 264) / 10, 0); ctx.lineTo((i * 264) / 10, 198) }
  for (let j = 1; j < 8; j++) { ctx.moveTo(0, (j * 198) / 8); ctx.lineTo(264, (j * 198) / 8) }
  ctx.stroke();
  ctx.strokeStyle = G;
  ctx.lineWidth = 2;
  for (const s of [-1, 1]) {
    const ex = cx + s * 52 + gx * 12, ey = cy - 30 + gy * 9 - bo * 7, r = 12 * sc;
    ctx.beginPath();
    if (hap > 0.5) ctx.arc(ex, ey + 6, r, Math.PI * 1.1, Math.PI * 1.9);
    else ctx.ellipse(ex, ey, r, Math.max(1, r * open), 0, 0, TAU);
    ctx.stroke();
  }
  const my = cy + 38, hw = 44 + m.w * 26 - m.r * 26, up = m.o * 9 + m.r * 7, dn = m.o * 20 + m.r * 9, rp = 1.7 * m.o + 0.35, pw = 0.75 - m.r * 0.35;
  ctx.beginPath();
  for (let i = 0; i <= 64; i++) {
    const s = i / 64, en = Math.sin(Math.PI * s), y = my - up * en ** pw + rp * Math.sin(s * 40 + T * 42) * en;
    if (i) ctx.lineTo(cx - hw + 2 * hw * s, y);
    else ctx.moveTo(cx - hw + 2 * hw * s, y);
  }
  for (let i = 64; i >= 0; i--) {
    const s = i / 64, en = Math.sin(Math.PI * s);
    ctx.lineTo(cx - hw + 2 * hw * s, my + dn * en ** pw + rp * Math.sin(s * 33 - T * 37) * en);
  }
  ctx.closePath();
  ctx.stroke();
}

const BLOC = [[0, 0], [1, 0], [0, 1], [1, 1]];
const PLUS = [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]];

export const THEMES = [
  { id: 'pixel', name: 'Pixel', family: 'Pixel', screen: 'rect', note: 'OLED 128×64, chaque pixel', make: () => oled(128, 1, [[0, 0]]) },
  { id: 'blocs', name: 'Blocs', family: 'Pixel', screen: 'rect', note: 'OLED, gros pixels carrés', make: () => oled(42, 3, BLOC) },
  { id: 'perles', name: 'Perles', family: 'Pixel', screen: 'rect', note: 'OLED, pixels en croix', make: () => oled(32, 4, PLUS) },
  { id: 'perles-fond', name: 'Perles allumées', family: 'Pixel', screen: 'rect', note: 'LED couleur, fond visible', make: () => dots(() => ({ cols: 28, shape: 'perle', bg: true })) },
  { id: 'grille', name: 'Sur mesure', family: 'Pixel', screen: 'rect', note: 'densité, forme, fond', make: () => dots(getCustom) },
  { id: 'trait', name: 'Trait', family: 'Trait', screen: 'round', note: 'yeux ronds, lèvres', make: () => vector(220, 220, traitClassic) },
  { id: 'trait-doux', name: 'Doux', family: 'Trait', screen: 'round', note: 'yeux arrondis pleins', make: () => vector(220, 220, traitSoft(false, false)) },
  { id: 'trait-contour', name: 'Contour', family: 'Trait', screen: 'round', note: 'tout en contours', make: () => vector(220, 220, traitSoft(true, false)) },
  { id: 'trait-neon', name: 'Néon', family: 'Trait', screen: 'round', note: 'contours lumineux', make: () => vector(220, 220, traitSoft(true, true)) },
  { id: 'chat-pixel', name: 'Chat pixel', family: 'Chats', screen: 'rect', note: 'OLED, oreilles qui frémissent', make: () => oled(128, 1, [[0, 0]], catLit) },
  { id: 'chat-perles', name: 'Chat perles', family: 'Chats', screen: 'rect', note: 'LED couleur, fond visible', make: () => dots(() => ({ cols: 52, shape: 'perle', bg: true }), catLit) },
  { id: 'chaton', name: 'Chaton', family: 'Chats', screen: 'round', note: 'grands yeux, joues roses', make: () => vector(220, 220, kitten) },
  { id: 'matrice', name: 'Matrice', family: 'Autres', screen: 'round', note: 'LED rondes 19×19', make: matrice },
  { id: 'oscillo', name: 'Oscillo', family: 'Autres', screen: 'wide', note: 'trace d’oscilloscope', make: () => vector(264, 198, oscillo, 23) },
];

export const themeById = (id) => THEMES.find((t) => t.id === id);

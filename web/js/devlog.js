// Le journal du mode développeur : ce que la page voit (erreurs, événements, messages) et ce que le serveur écrit
// (GET /api/logs). Il tourne toujours, même tiroir fermé : le diagnostic copié a ainsi de l'historique.
const MAX = 300;
const SECRET = /([?&](?:t|s|p|u|token|key|apikey|password)=)[^&\s"]+|\b(gsk_|sk-)[\w-]+/gi;
const lines = [];
let list = null, after = 0, boot = '', timer = 0, polling = null;

export const redact = (text) => String(text).replace(SECRET, (_, q, k) => `${q || k}•••`);
const fmt = (x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'object' ? safeJson(x) : String(x));
function safeJson(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

export function log(level, text, src = 'page', t = Date.now()) {
  const line = { t, src, level, text: redact(text).slice(0, 2000) };
  lines.push(line);
  if (lines.length > MAX) lines.shift();
  if (list) show(line);
}

function show(line) {
  const li = document.createElement('li'), time = document.createElement('time'), tag = document.createElement('i');
  li.className = `${line.src === 'page' ? '' : 'srv'} lv-${line.level}`;
  time.textContent = hhmmss(line.t);
  tag.textContent = line.src;
  li.append(time, tag, line.text);
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.append(li);
  while (list.childElementCount > MAX) list.firstElementChild.remove();
  if (atEnd) list.scrollTop = list.scrollHeight;
}

const LEVEL = { WARNING: 'warn', ERROR: 'error', CRITICAL: 'error' };
// Un seul appel à la fois : deux appels partis avec le même `after` recopiaient les mêmes lignes.
const poll = () => (polling ??= pull().finally(() => { polling = null }));
async function pull() {
  try {
    const res = await fetch(`/api/logs?after=${after}&boot=${boot}`).then((r) => r.json());
    if (res.boot && res.boot !== boot) [boot, after] = [res.boot, 0]; // serveur relancé : il recompte depuis 1
    for (const l of res.lines || []) {
      if (l.n <= after) continue;
      after = l.n;
      log(LEVEL[l.level] || 'info', `${l.name.replace(/^eli\./, '')} · ${l.msg}`, 'srv', l.t * 1000);
    }
  } catch {
    // serveur ancien (pas de /api/logs) ou injoignable : le journal de la page suffit
  }
}

export function openDrawer(ol) {
  list = ol;
  list.replaceChildren();
  lines.forEach(show);
  poll();
  clearInterval(timer);
  timer = setInterval(poll, 2000);
}

export function closeDrawer() {
  clearInterval(timer);
  list = null;
}

export function clear() {
  lines.length = 0;
  list?.replaceChildren();
}

// Le texte à coller dans une issue : contexte, puis les deux journaux. Pas de clés, pas de mots de passe.
export async function diagnostic(context) {
  await poll();
  const head = Object.entries(context).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : safeJson(v)}`);
  const body = lines.map((l) => `${hhmmss(l.t)} ${l.src.padEnd(4)} ${l.level.padEnd(5)} ${l.text}`);
  return redact(['## Eli · diagnostic', ...head, '', '## Journal', ...body].join('\n'));
}

// Toujours à l'écoute : erreurs et avertissements de la console, exceptions, promesses rejetées.
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    log(level, args.map(fmt).join(' '));
    orig(...args);
  };
}
addEventListener('error', (e) => log('error', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
addEventListener('unhandledrejection', (e) => log('error', `promesse rejetée : ${fmt(e.reason)}`));

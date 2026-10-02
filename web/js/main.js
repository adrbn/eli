// Eli — la page « écran ». Elle reçoit tout par le protocole (SSE), comme le fera l'ESP32, et sert
// aussi de télécommande : micro, texte, glisser-déposer, choix du visage.
import { HOP, SR, crossed, encodeWav, mouthAt, sample } from './analysis.js';
import { Mic, Player, to16k } from './audio.js';
import { Face } from './face.js';
import { Segmenter } from './hotword.js';
import { Sleeper, wakeTime } from './sleep.js';
import { GREEN, LOOKS, Notes, mixColor } from './looks.js';
import { THEMES, getCustom, setCustom, setInk, themeById } from './themes.js';
import * as devlog from './devlog.js';
import { initLibrary } from './library.js';
import { lang, pickLang, setLang, t, translateDom } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const CLIENT = Math.random().toString(36).slice(2, 10);
const AUDIO_FILE = /\.(wav|mp3|m4a|aac|flac|ogg|oga|opus|aiff?|caf|webm|mp4)$/i;
const MAX_FILE = 150 * 1024 * 1024;
// ?bare=1 : le visage seul, sans interface (l'encoche de l'app Mac, un cadre…).
// ?mirror=1 en plus : un reflet muet d'un autre écran, qui ne lui prend jamais la parole.
const params = new URLSearchParams(location.search);
const BARE = params.has('bare'), MIRROR = params.has('mirror');
if (BARE) document.body.classList.add('bare');
// ?app=mac / ?app=ios : la page vit dans une app native, qui la pilote par window.eliHost (plus bas).
const APP = params.get('app');
if (APP) document.body.classList.add('app', `app-${APP}`);
document.body.dataset.layout = 'window';
const native = (msg) => window.webkit?.messageHandlers?.eli?.postMessage(msg);
const MAX_PTT_MS = 30000, TAP_MS = 300;
const FOLLOW_MS = 6000; // après « Eli » seul, le temps qu'il t'écoute avant de laisser tomber

// Réglages retenus par ce navigateur ; le stockage peut être indisponible (navigation privée) : on s'en passe.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`eli.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`eli.${key}`, JSON.stringify(value));
    } catch {
      // réglage simplement non retenu
    }
  },
};

const saved = store.get('settings', {});
let settings = {
  lead: clamp(Number(saved.lead ?? 50) || 0, -100, 200),
  volume: clamp(Number(saved.volume ?? 0.9), 0, 1),
  captions: saved.captions !== false,
  mouse: saved.mouse !== false,
  snore: saved.snore !== false,
  hotword: saved.hotword === true,
  brief: saved.brief !== false,
  look: typeof saved.look === 'string' ? saved.look : 'auto',
  dev: saved.dev === true || params.has('dev'),
  lang: saved.lang === 'fr' || saved.lang === 'en' ? saved.lang : 'auto',
  notes: saved.notes !== false, // les notes de musique autour de lui quand il chante
  decoAsked: saved.decoAsked === true, // le choix tenue / notes proposé au premier morceau
  color: /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color.toLowerCase() : GREEN, // la couleur de l'écran (OLED vert, blanc…)
};
// La langue de la page : ?lang=, puis Réglages, puis ELI_LANG du serveur (au « hello »), puis le navigateur.
const langFor = (server) => pickLang({ query: params.get('lang'), saved: settings.lang, server, nav: navigator.languages?.[0] || navigator.language });
setLang(langFor());
const savedCustom = store.get('custom', {});
setCustom({
  cols: clamp(Math.round((Number(savedCustom.cols) || 40) / 2) * 2, 16, 64),
  shape: savedCustom.shape === 'carre' ? 'carre' : 'perle',
  bg: savedCustom.bg !== false,
});

const el = {
  bezel: $('#bezel'), screen: $('#screen'), caption: $('#caption'), toast: $('#toast'), dock: $('#dock'),
  mic: $('#btn-mic'), chat: $('#chat'), input: $('#chat-input'), status: $('#status'), info: $('#info'),
  themes: $('#panel-themes'), settings: $('#panel-settings'), music: $('#panel-music'), groups: $('#theme-groups'), custom: $('#custom'),
  drop: $('#drop'), wake: $('#wake'), file: $('#file'), voice: $('#s-voice'), voiceHint: $('#s-voice-hint'),
  now: $('#now'), nowLine: $('#now-line'), nowNext: $('#now-next'), nowTitle: $('#now-title'), nowPlay: $('#now-play'),
  nowIcon: $('#now-icon'), nowSeek: $('#now-seek'), nowTime: $('#now-time'), nowDur: $('#now-dur'), devlog: $('#devlog'),
};

const face = new Face();
const player = new Player((item) => toast(t('Son illisible ({name}) : {error}', { name: item.meta.name || 'clip', error: item.error?.message || t('format inconnu') })));
const mic = new Mic(player);
const sleeper = new Sleeper(player);
const screenCtx = el.screen.getContext('2d');
const previews = [];

let theme = themeById(store.get('theme', 'pixel')) || THEMES[0];
let draw = theme.make();
let online = false, info = null, statusText = '';
let serverMode = 'idle', serverGaze = null, mouseGaze = null, minTurn = 0;
let ptt = false, pttTimer = 0, pttAt = 0, latched = false, passive = false, moodUntil = 0;
let lastItem = null, lastAt = 0, holdUntil = 0, captionUntil = 0;

// --- messages à l'utilisateur ---------------------------------------------------------------
let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  devlog.log('info', `toast · ${text}`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 6000);
}
const report = (err) => toast(err?.message || String(err));

function note(text) {
  if (text && text !== statusText) devlog.log('info', `statut · ${text}`);
  statusText = text;
  renderStatus();
}

function renderStatus() {
  el.status.textContent = online ? statusText || t('Prêt') : t('Serveur injoignable…');
  el.status.classList.toggle('off', !online);
}

function caption(text, kind = '', ms = 0) {
  el.caption.textContent = settings.captions ? text : '';
  el.caption.className = `caption ${kind}`;
  captionUntil = ms ? performance.now() + ms : 0;
}

const EARS = { echo: 'Écho (serveur maison)', groq: 'Groq Whisper' }; // traduit à l'affichage
function renderInfo() {
  if (!info) return;
  const rows = [
    [t('Voix'), info.tts],
    [t('Oreilles'), (info.stt || '').split(',').map((p) => (EARS[p.trim()] ? t(EARS[p.trim()]) : p.trim())).join(t(', puis '))],
    [t('Cerveau'), info.llm || t('pas de clé Groq (il le dira)')],
    [t('Chant'), info.stems ? t('MDX-Net, voix isolée en direct') : t('modèle de voix absent : il danse sans chanter')],
    ['Version', info.version || '?'],
  ];
  el.info.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    return [dt, dd];
  }));
}

// --- serveur --------------------------------------------------------------------------------
async function post(path, body, type = 'application/json') {
  const init = { method: 'POST' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': type };
    init.body = type === 'application/json' ? JSON.stringify(body) : body;
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    devlog.log('warn', `POST ${path} → ${res.status} ${data.error || ''}`);
    throw new Error(data.error || t('le serveur répond {status}', { status: res.status }));
  }
  return data;
}

// Le choix de la voix : la liste vient du serveur, qui prévient (événement « voice ») quand il a basculé.
function renderVoices(c) {
  const busy = c.busy ? c.voices.find((v) => v.id === c.busy) : null;
  el.voice.replaceChildren(...c.voices.map((v) => new Option(v.ready ? v.label : t('{label} (à télécharger)', { label: v.label }), v.id)));
  el.voice.value = c.busy || c.current;
  el.voice.disabled = Boolean(busy);
  $('#s-catvoice').checked = Boolean(c.cat);
  el.voiceHint.textContent = busy ? t('Je prends la voix {name}…', { name: busy.label.split(' ·')[0] }) : c.error ? t('Raté : {error}', { error: c.error }) : t('Toutes locales. Les voix Piper se téléchargent au premier choix (~60 Mo).');
}

function connect() {
  const es = new EventSource('/events');
  const on = (name, fn) => es.addEventListener(name, (e) => {
    const d = JSON.parse(e.data);
    // pas la progression de la voix isolée : un bloc toutes les 5 s noyait le reste
    if (name !== 'gaze' && !(name === 'stem' && d.total)) devlog.log('info', `← ${name} ${e.data.slice(0, 160)}`);
    fn(d);
  });
  on('hello', (s) => {
    online = true;
    info = s;
    fetch('/api/voices').then((r) => r.json()).then((c) => c.voices && renderVoices(c)).catch(report);
    serverMode = s.mode || 'idle';
    serverGaze = s.gaze || null;
    minTurn = s.turn || 0;
    if (s.theme && s.theme !== theme.id && themeById(s.theme)) applyTheme(s.theme, false);
    else if (s.theme !== theme.id) post('/theme', { id: theme.id, from: CLIENT }).catch(report);
    relang(s.lang_setting);
    renderInfo();
    renderStatus();
    // la page dit sa langue au serveur (voix, présentation, point du matin) avant qu'Eli ne parle ; un vieux serveur répond 404
    (MIRROR ? Promise.resolve() : post('/lang', { lang }).catch(() => {})).finally(() => {
      maybeIntro();
      maybeBrief();
    });
  });
  on('clip', onClip);
  on('music', renderMusic);
  on('genre', (d) => clipLooks.set(d.id, d.look));
  on('lyrics', (d) => clipLyrics.set(d.id, d));
  on('take', (d) => { if (d.client !== CLIENT) yieldTo() });
  on('setup', (d) => { if (d.need === 'navidrome') askMusic() });
  on('voice', (c) => {
    renderVoices(c);
    if (!c.busy) fetch('/api/status').then((r) => r.json()).then((s) => { info = s; renderInfo() }).catch(report);
  });
  on('stem', (d) => {
    if (d.error) return toast(t('Voix du morceau non isolée : {error}', { error: d.error }));
    player.attachStem(d.id, d.url)
      .then((ok) => { if (ok && !d.done) note('') })
      .catch((err) => toast(t('Voix isolée illisible : {error}', { error: err.message })));
  });
  on('state', (d) => {
    serverMode = d.mode;
    face.wake(d.mode === 'idle'); // le serveur qui se repose ne tire pas d'un sommeil commandé
  });
  on('sleep', (d) => { if (d.turn >= minTurn) pendingSleep = { until: wakeTime(d.at), turn: d.turn } });
  on('gaze', (d) => { serverGaze = d.gaze });
  on('theme', (d) => { if (d.from !== CLIENT) applyTheme(d.id, false) });
  on('stop', (d) => {
    minTurn = Math.max(minTurn, d.turn || 0);
    player.stop(d.keep || null);
  });
  on('brain', onBrain);
  es.onerror = () => {
    if (online) devlog.log('warn', 'flux /events coupé, reconnexion…');
    online = false; // EventSource se reconnecte tout seul
    renderStatus();
  };
}

// La toute première fois, Eli se présente et pose quelques questions ; on répond à la voix ou par écrit.
function maybeIntro() {
  if (passive || MIRROR || store.get('met', false)) return;
  fetch('/api/memory').then((r) => r.json()).then((m) => {
    store.set('met', true);
    if (!m.notes && !m.messages) startIntro();
  }).catch(report);
}

// Le point du matin : une fois par jour, entre 5 h et midi, quand Eli se réveille et peut parler.
function maybeBrief() {
  const now = new Date(), day = now.toDateString();
  if (!settings.brief || passive || MIRROR || !player.ready || !store.get('met', false)) return;
  if (now.getHours() < 5 || now.getHours() >= 12 || store.get('briefDay', '') === day) return;
  store.set('briefDay', day);
  post('/brain/brief').then(({ turn }) => { minTurn = Math.max(minTurn, turn) }, report);
}

function startIntro() {
  post('/brain/intro').then(({ turn }) => {
    minTurn = Math.max(minTurn, turn);
    note(t('Réponds-lui : maintiens Espace pour parler, ou écris en bas.'));
  }, report);
}

function onClip(meta) {
  if (passive) return;
  if (meta.turn > 0 && meta.turn < minTurn) return; // reste d'une réplique interrompue
  face.wake();
  player.enqueue(meta);
  if (meta.kind === 'music') note(meta.stem === 'off' ? t('Sans modèle de voix, je danse sans chanter.') : ''); // fini, « Je cherche… »
  if (!player.ready) el.wake.hidden = false;
}

function onBrain(d) {
  if (d.stage === 'stt') note(t('Je transcris…'));
  else if (d.stage === 'heard') {
    if (d.text) caption(t('« {text} »', { text: d.text }), 'you', 8000);
    note(d.text ? t('Je réfléchis…') : t('Je n’ai rien entendu.'));
  } else if (d.stage === 'llm') note(t('Je réfléchis…'));
  else if (d.stage === 'music') note(t('Je cherche « {q} » dans ta bibliothèque…', { q: d.text || t('un morceau') }));
  else if (d.stage === 'fetch') note(t('Je télécharge « {q} »…', { q: d.text }));
  else if (d.stage === 'done') note('');
  else if (d.stage === 'error') toast(t('Cerveau en panne : {error}', { error: d.error }));
}

// --- visages --------------------------------------------------------------------------------
function applyTheme(id, broadcast = true) {
  const next = themeById(id);
  if (!next) return;
  theme = next;
  draw = theme.make();
  face.cat = theme.family === 'Chats';
  el.bezel.dataset.screen = theme.screen;
  for (const p of previews) p.button.setAttribute('aria-pressed', String(p.theme === theme));
  store.set('theme', theme.id);
  if (broadcast) post('/theme', { id: theme.id, from: CLIENT }).catch(report);
}

function cycleTheme(step) {
  const i = THEMES.indexOf(theme);
  applyTheme(THEMES[(i + step + THEMES.length) % THEMES.length].id);
  note(t('Visage : {name}', { name: t(theme.name) }));
}

function buildThemes() {
  for (const family of ['Pixel', 'Chats', 'Trait', 'Autres']) {
    const title = document.createElement('h3'), cards = document.createElement('div');
    title.textContent = t(family);
    cards.className = 'cards';
    for (const th of THEMES.filter((x) => x.family === family)) {
      const button = document.createElement('button'), canvas = document.createElement('canvas');
      const name = document.createElement('span'), noteEl = document.createElement('span');
      button.type = 'button';
      button.className = 'card';
      button.dataset.screen = th.screen;
      button.setAttribute('aria-pressed', String(th === theme));
      name.className = 'name';
      name.textContent = t(th.name);
      noteEl.className = 'note';
      noteEl.textContent = t(th.note);
      button.append(canvas, name, noteEl);
      button.addEventListener('click', () => applyTheme(th.id));
      cards.append(button);
      previews.push({ theme: th, button, canvas, ctx: canvas.getContext('2d'), draw: th.make() });
    }
    el.groups.append(title, cards);
    if (family === 'Pixel') el.groups.append(el.custom);
  }
}

function bindCustom() {
  const cols = $('#c-cols'), out = $('#c-cols-out'), bg = $('#c-bg'), shapes = document.querySelectorAll('[data-shape]');
  const render = () => {
    const c = getCustom();
    cols.value = c.cols;
    out.textContent = `${c.cols} × ${c.cols / 2}`;
    bg.checked = c.bg;
    shapes.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.shape === c.shape)));
  };
  const change = (patch) => {
    setCustom(patch);
    store.set('custom', getCustom());
    render();
    if (theme.id !== 'grille') applyTheme('grille');
  };
  cols.addEventListener('input', () => change({ cols: Number(cols.value) }));
  bg.addEventListener('change', () => change({ bg: bg.checked }));
  shapes.forEach((b) => b.addEventListener('click', () => change({ shape: b.dataset.shape })));
  render();
}

function bindSettings() {
  const lead = $('#s-lead'), leadOut = $('#s-lead-out'), volume = $('#s-volume'), captions = $('#s-captions'), mouse = $('#s-mouse'), snore = $('#s-snore'), hot = $('#s-hotword'), brief = $('#s-brief'), look = $('#s-look');
  const update = (patch) => {
    settings = { ...settings, ...patch };
    store.set('settings', settings);
    player.setVolume(MIRROR ? 0 : settings.volume);
    leadOut.textContent = `${settings.lead > 0 ? '+' : ''}${settings.lead} ms`;
  };
  lead.value = settings.lead;
  volume.value = settings.volume;
  captions.checked = settings.captions;
  mouse.checked = settings.mouse;
  snore.checked = settings.snore;
  hot.checked = settings.hotword;
  brief.checked = settings.brief;
  look.append(...Object.keys(LOOKS).map((id) => new Option('', id)));
  lookNames();
  look.value = LOOKS[settings.look] || settings.look === 'off' ? settings.look : 'auto';
  update({});
  if (settings.hotword && !MIRROR) hotword(true);
  hot.addEventListener('change', () => {
    update({ hotword: hot.checked });
    hotword(hot.checked);
  });
  snore.addEventListener('change', () => update({ snore: snore.checked }));
  brief.addEventListener('change', () => update({ brief: brief.checked }));
  look.addEventListener('change', () => update({ look: look.value }));
  const notesFx = $('#s-notesfx'), deco = $('#deco');
  notesFx.checked = settings.notes;
  notesFx.addEventListener('change', () => update({ notes: notesFx.checked }));
  for (const b of deco.querySelectorAll('[data-deco]')) {
    b.addEventListener('click', () => {
      const pick = b.dataset.deco;
      look.value = pick === 'all' ? (settings.look === 'off' ? 'auto' : settings.look) : 'off';
      notesFx.checked = pick !== 'none';
      update({ look: look.value, notes: notesFx.checked });
      deco.hidden = true;
    });
  }
  const colors = $('#s-color'), pick = $('#s-color-pick');
  const showColor = () => {
    document.documentElement.style.setProperty('--green', settings.color); // l'interface prend la couleur d'Eli
    for (const b of colors.querySelectorAll('[data-color]')) b.setAttribute('aria-checked', String(b.dataset.color === settings.color));
    pick.value = settings.color;
  };
  colors.addEventListener('click', (e) => {
    const c = e.target.closest('[data-color]')?.dataset.color;
    if (c) update({ color: c }), showColor();
  });
  pick.addEventListener('input', () => { update({ color: pick.value }); showColor() });
  showColor();
  const langSel = $('#s-lang');
  langSel.value = settings.lang;
  langSel.addEventListener('change', () => {
    update({ lang: langSel.value });
    relang(info?.lang_setting);
    if (!MIRROR) post('/lang', { lang }).catch(() => {});
  });
  const dev = $('#s-dev');
  dev.checked = settings.dev;
  dev.addEventListener('change', () => setDev(dev.checked));
  setDev(settings.dev);
  $('#s-report').addEventListener('click', copyDiagnostic);
  $('#devlog-copy').addEventListener('click', copyDiagnostic);
  $('#devlog-clear').addEventListener('click', devlog.clear);
  $('#devlog-close').addEventListener('click', () => setDev(false));
  document.querySelectorAll('input[type="range"]').forEach(paint);
  lead.addEventListener('input', () => update({ lead: Number(lead.value) }));
  volume.addEventListener('input', () => update({ volume: Number(volume.value) }));
  captions.addEventListener('change', () => {
    update({ captions: captions.checked });
    if (!settings.captions) caption('');
  });
  mouse.addEventListener('change', () => {
    update({ mouse: mouse.checked });
    if (!settings.mouse) mouseGaze = null;
  });
  let fileKind = 'speech';
  $('#s-speech-file').addEventListener('click', () => { fileKind = 'speech'; el.file.click() });
  $('#s-music-file').addEventListener('click', () => { fileKind = 'music'; el.file.click() });
  el.file.addEventListener('change', () => {
    const file = el.file.files[0];
    el.file.value = '';
    if (file) sendFile(file, fileKind);
  });
  const notes = $('#s-notes');
  const loadNotes = () => fetch('/api/memory').then((r) => r.json()).then((m) => {
    notes.replaceChildren(...(m.notes || '').split('\n').filter(Boolean).map((line) => {
      const li = document.createElement('li');
      li.textContent = line.replace(/^-\s*/, '');
      return li;
    }));
  }).catch(report);
  $('#btn-settings').addEventListener('click', loadNotes);
  $('#s-intro').addEventListener('click', () => {
    togglePanel(el.settings);
    startIntro();
  });
  $('#s-forget').addEventListener('click', () => {
    if (confirm(t('Effacer la conversation et tous les souvenirs d’Eli ?'))) post('/brain/reset?all=1').then(() => { note(t('J’ai tout oublié.')); loadNotes() }, report);
  });
  el.voice.addEventListener('change', () => post('/voice', { id: el.voice.value }).catch(report));
  $('#s-catvoice').addEventListener('change', (e) => post('/voice', { cat: e.target.checked }).catch(report));
  $('#s-stop').addEventListener('click', () => stopAll('music'));
  $('#s-reset').addEventListener('click', () => post('/brain/reset').then(() => note(t('Conversation oubliée.')), report));
}

// --- musique (Navidrome) : le panneau Musique (library.js) ; Eli l'ouvre tout seul quand on lui demande un morceau sans accès ---
const library = initLibrary({ post, note, report, stopAll });
const renderMusic = (m) => library.render(m);
function askMusic() {
  if (BARE) return;
  if (el.music.hidden) togglePanel(el.music);
  const form = $('#m-connect');
  form.classList.remove('ask');
  void form.offsetWidth; // relance l'animation
  form.classList.add('ask');
  note(t('Donne-moi l’accès à ta bibliothèque Navidrome.'));
}

// --- panneaux et dock -----------------------------------------------------------------------
function togglePanel(panel) {
  const open = panel.hidden;
  closePanels();
  panel.hidden = !open;
  if (open && panel === el.music) library.opened();
  showDock();
}
const panels = () => [el.themes, el.settings, el.music];
function closePanels() {
  for (const p of panels()) p.hidden = true;
}
// Au tout premier morceau, une fois : garder la tenue et les notes, ou pas (sans réponse, tout reste comme avant).
function askDeco() {
  if (settings.decoAsked || BARE || MIRROR || document.body.dataset.layout !== 'window') return;
  settings = { ...settings, decoAsked: true };
  store.set('settings', settings);
  $('#deco').hidden = false;
}
// un clic à côté d'un panneau ouvert le ferme (le dock garde ses boutons : ils ouvrent et ferment eux-mêmes)
addEventListener('pointerdown', (e) => {
  if (panels().some((p) => !p.hidden) && !e.target.closest('.panel, .dock, .devlog, .toast')) closePanels();
});

let dockTimer = 0;
function showDock() {
  el.dock.classList.remove('away');
  document.body.classList.remove('calm');
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => {
    const busy = el.dock.matches(':hover, :focus-within') || el.now.matches(':hover, :focus-within') || seeking || panels().some((p) => !p.hidden) || ptt;
    if (busy) return showDock();
    el.dock.classList.add('away');
    document.body.classList.add('calm');
  }, 3500);
}

// --- parler : micro, texte, fichiers --------------------------------------------------------
// keep = 'music' (Échap, « Couper la parole ») : il se tait, mais le morceau continue.
function stopAll(keep = null) {
  minTurn += 1; // le serveur va passer au tour suivant : ce qui reste du tour coupé est périmé
  player.stop(keep);
  note('');
  return post('/stop', keep ? { keep } : undefined).catch(report); // à attendre avant de lancer un morceau, qu'il ne l'annule pas
}

// --- le lecteur, sous le visage : la ligne chantée (paroles LRCLIB, événement « lyrics »), la suivante, le morceau ---
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const clipLyrics = new Map();
let seeking = false, nowAt = 0, nowKey = '', lyricAt = -2, hostState = '';
// Les curseurs se remplissent jusqu'à leur valeur (la piste est un dégradé réglé par --v).
function paint(range) {
  const min = Number(range.min) || 0, max = Number(range.max) || 1;
  range.style.setProperty('--v', `${((Number(range.value) - min) / (max - min)) * 100}%`);
}
addEventListener('input', (e) => { if (e.target.matches?.('input[type="range"]')) paint(e.target) });

function renderTitle(m, ly) {
  const b = document.createElement('b'), span = document.createElement('span');
  b.textContent = ly?.title || (m.meta.name || t('musique')).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ');
  span.textContent = ly?.artist ? ` · ${ly.artist}` : '';
  el.nowTitle.replaceChildren(b, span);
  el.nowTitle.title = el.nowTitle.textContent;
  el.nowLine.parentElement.hidden = !ly?.lines?.length;
  lyricAt = -2;
}

// La voix isolée se calcule bloc par bloc pendant que le morceau joue, à peu près au rythme de la lecture sur un M1 :
// au début, après un saut en avant ou quand le Mac rame, elle n'est pas encore là. D'ici là, les paroles synchronisées
// disent quand il chante, et la bouche suit le volume du morceau sur un rythme de syllabes.
function guessMouth(id, at, energy) {
  const lines = clipLyrics.get(id)?.lines;
  if (!lines) return null;
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1][0] <= at) i += 1;
  if (i < 0 || !lines[i][1]?.trim()) return null;
  const syllable = 0.5 + 0.5 * Math.sin(at * 2 * Math.PI * 4.2) * Math.sin(at * 2 * Math.PI * 1.3 + 1);
  return { o: clamp(energy, 0, 1) * (0.2 + 0.7 * syllable), w: 0.45, r: 0.25, t: 0 };
}

function renderLyrics(lines, pos) {
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1][0] <= pos) i += 1;
  if (i === lyricAt) return;
  lyricAt = i;
  el.nowLine.textContent = i < 0 ? '' : lines[i][1] || '♪';
  el.nowNext.textContent = lines[i + 1]?.[1] || '';
  el.nowLine.classList.remove('in');
  void el.nowLine.offsetWidth; // relance l'animation d'entrée
  el.nowLine.classList.add('in');
}

function renderNow() {
  const m = player.ready ? player.music() : null;
  document.body.classList.toggle('playing', Boolean(m));
  el.now.hidden = !m;
  const paused = Boolean(m) && m.paused !== null && m.paused !== undefined;
  const state = m ? `${!paused}|${el.nowTitle.textContent}` : 'false|';
  if (APP && state !== hostState) { // l'app native en fait son menu Musique et l'indicateur de l'encoche
    hostState = state;
    native({ type: 'state', loaded: Boolean(m), singing: Boolean(m) && !paused, title: m ? el.nowTitle.textContent : '' });
  }
  if (!m) return void (nowKey = '');
  const ly = clipLyrics.get(m.meta.id), key = `${m.meta.id}|${Boolean(ly)}`;
  if (key !== nowKey) {
    nowKey = key;
    renderTitle(m, ly);
  }
  const pos = player.position(m), dur = m.buffer.duration;
  if (ly?.lines?.length) renderLyrics(ly.lines, pos + settings.lead / 1000);
  if (!seeking) {
    el.nowSeek.value = pos / dur;
    paint(el.nowSeek);
  }
  el.nowTime.textContent = clock(seeking ? el.nowSeek.value * dur : pos);
  el.nowDur.textContent = clock(dur);
  el.nowIcon.setAttribute('d', paused ? 'M8 5.5v13l11-6.5z' : 'M9 6v12M15 6v12');
  el.nowPlay.setAttribute('aria-label', paused ? t('Lecture') : 'Pause');
}
function toggleMusic() {
  const m = player.music();
  if (m) player.toggle(m);
}
el.nowPlay.addEventListener('click', toggleMusic);
$('#now-stop').addEventListener('click', () => stopAll());
// Précédent / suivant : le serveur retient les morceaux chantés (au-delà du dernier, un au hasard).
function stepSong(dir) {
  stopAll().then(() => post(`/music/${dir}`)).catch(report);
  note(t('Je cherche le morceau…'));
}
$('#now-back').addEventListener('click', () => stepSong('prev'));
$('#now-skip').addEventListener('click', () => stepSong('next'));
el.nowSeek.addEventListener('input', () => { seeking = true });
el.nowSeek.addEventListener('change', () => {
  seeking = false;
  const m = player.music();
  if (m) player.seek(m, Number(el.nowSeek.value) * m.buffer.duration);
});

// Maintenir = parler tant qu'on tient ; un simple clic = micro ouvert jusqu'au clic suivant.
async function pttStart() {
  if (ptt) {
    if (latched) pttEnd();
    return;
  }
  ptt = true;
  pttAt = performance.now();
  el.mic.classList.add('on');
  face.wake();
  showDock();
  minTurn += 1;
  player.stop(); // on lui coupe la parole : il se tait et abandonne sa réponse
  post('/stop').catch(report);
  try {
    await player.unlock();
    await mic.start();
    if (!ptt) {
      mic.stop(); // relâché pendant l'ouverture du micro
      return;
    }
    note(latched ? t('Je t’écoute… (reclique pour envoyer)') : t('Je t’écoute… (relâche pour envoyer)'));
    pttTimer = setTimeout(pttEnd, MAX_PTT_MS);
  } catch (err) {
    ptt = false;
    el.mic.classList.remove('on');
    toast(micError(err));
  }
}

function pttRelease() {
  if (ptt && !latched && performance.now() - pttAt < TAP_MS) {
    latched = true;
    note(t('Je t’écoute… (reclique pour envoyer)'));
    return;
  }
  pttEnd();
}

async function pttEnd() {
  if (!ptt) return;
  ptt = false;
  latched = false;
  clearTimeout(pttTimer);
  el.mic.classList.remove('on');
  const buffer = mic.stop();
  if (!buffer || buffer.duration < 0.3) {
    note(t('Trop court : maintiens pendant que tu parles.'));
    return;
  }
  serverMode = 'think';
  note(t('J’envoie…'));
  try {
    const wav = encodeWav(await to16k(buffer), SR);
    const { turn } = await post('/brain/listen', wav, 'audio/wav');
    minTurn = Math.max(minTurn, turn);
  } catch (err) {
    serverMode = 'idle';
    report(err);
  }
}

// --- « Eli, … » : écoute permanente ------------------------------------------------------------
// Chaque bout de phrase part au serveur, qui ne transcrit que ce qui ressemble à son nom (voir server/hotword.py).
let segmenter = null, hotBusy = false, followUntil = 0;

async function hotword(on) {
  el.mic.classList.toggle('ear', on);
  if (!on) {
    mic.taps.delete(hotTap);
    segmenter = null;
    followUntil = 0;
    mic.close();
    return;
  }
  try {
    await mic.open();
    segmenter = new Segmenter(player.ctx.sampleRate, hotSegment);
    mic.taps.add(hotTap);
  } catch (err) {
    el.mic.classList.remove('ear');
    $('#s-hotword').checked = false;
    settings = { ...settings, hotword: false };
    store.set('settings', settings);
    toast(micError(err));
  }
}

// Ni pendant qu'il parle (il s'entendrait), ni pendant « appuyer pour parler », ni dans un onglet passif.
function hotTap(x, level) {
  if (ptt || passive || hotBusy || player.busy()) segmenter?.reset();
  else segmenter?.push(x, level);
}

async function hotSegment(chunks) {
  hotBusy = true;
  const follow = performance.now() < followUntil;
  followUntil = 0;
  try {
    const wav = encodeWav(await to16k(mic.buffer(chunks)), SR);
    if (follow) { // il attendait la suite de « Eli ? »
      serverMode = 'think';
      const { turn } = await post('/brain/listen', wav, 'audio/wav');
      minTurn = Math.max(minTurn, turn);
      return;
    }
    const res = await post('/brain/hotword', wav, 'audio/wav');
    if (!res.wake) return;
    face.wake();
    if (res.listen) {
      followUntil = performance.now() + FOLLOW_MS;
      note(t('Oui ? Je t’écoute…'));
    } else {
      minTurn = Math.max(minTurn, res.turn);
      serverMode = 'think';
    }
  } catch (err) {
    serverMode = 'idle';
    report(err);
  } finally {
    hotBusy = false;
  }
}

function micError(err) {
  if (err?.name === 'NotAllowedError') return t('Micro refusé : autorise-le pour cette page (icône dans la barre d’adresse), puis réessaie.');
  if (err?.name === 'NotFoundError') return t('Aucun micro trouvé.');
  return t('Micro indisponible : {error}', { error: err?.message || err });
}

async function sendChat(raw) {
  const verbatim = raw.startsWith('>'), text = (verbatim ? raw.slice(1) : raw).trim();
  if (!text) return;
  try {
    if (!verbatim) {
      serverMode = 'think';
      caption(t('« {text} »', { text }), 'you', 8000);
    }
    devlog.log('info', `→ ${verbatim ? 'dire' : 'chat'} · ${text}`);
    const { turn } = await post(verbatim ? '/brain/speak' : '/brain/chat', { text });
    minTurn = Math.max(minTurn, turn);
  } catch (err) {
    serverMode = 'idle';
    report(err);
  }
}

async function sendFile(file, kind) {
  if (!file.type.startsWith('audio/') && !AUDIO_FILE.test(file.name)) return toast(t('Il me faut un fichier audio (wav, mp3, m4a, flac…).'));
  if (file.size > MAX_FILE) return toast(t('Fichier trop gros : 150 Mo maximum.'));
  stopAll(); // un son déposé passe devant tout : sinon il attendrait la fin du morceau en cours
  note(kind === 'music' ? t('J’écoute le morceau…') : t('Je prépare le son…'));
  try {
    await post(`/clip?kind=${kind}&name=${encodeURIComponent(file.name)}`, file, file.type || 'application/octet-stream');
  } catch (err) {
    report(err);
  }
}

// --- perception et rendu --------------------------------------------------------------------
// Balancement sur 4 temps, accroché aux temps détectés (pas au tempo moyen, qui dériverait).
function swayPhase(tr, at) {
  let i = -1;
  while (i + 1 < tr.beats.length && tr.beats[i + 1] <= at) i += 1;
  const a = i >= 0 ? tr.beats[i] : (tr.beats[0] ?? 0) - tr.period, b = tr.beats[i + 1] ?? a + tr.period;
  return (Math.PI / 2) * (i + clamp((at - a) / (b - a), 0, 1));
}

// Ce que le visage perçoit à cet instant : ce qu'il dit ou chante, où regarder, l'humeur de fond.
function sense(now) {
  const h = player.heard(), item = player.ready ? player.at(h) : null;
  const s = { mode: serverMode, mouth: null, gaze: serverGaze || (settings.mouse ? mouseGaze : null), micLevel: mic.level };
  if (lastItem && item !== lastItem) s.clipEnd = true;
  if (item?.meta.mood) { // l'émotion de la phrase entendue, qui s'attarde un peu après
    face.mood = item.meta.mood;
    moodUntil = now + 1500;
  } else if (now > moodUntil) face.mood = null;
  if (item) {
    const tr = item.track, at = h - item.t0 + settings.lead / 1000, prev = item === lastItem ? lastAt : -1;
    if (item !== lastItem) {
      caption(item.kind === 'music' ? `♪ ${item.meta.name || t('musique')}` : item.meta.text, item.kind);
      if (item.kind === 'music') askDeco();
      if (statusText === t('Je réfléchis…') || statusText === t('J’envoie…')) note('');
    }
    if (item.kind === 'speech') {
      s.mode = 'speak';
      s.mouth = mouthAt(tr, at);
      s.phraseStart = crossed(tr.starts, prev, at) >= 0;
      s.pause = crossed(tr.pauses, prev, at) >= 0;
    } else {
      const b = crossed(tr.beats, prev, at);
      s.mode = 'sing';
      s.song = item.meta.id;
      if (b >= 0) s.beat = 0.35 + 0.65 * tr.strength[b];
      s.sway = swayPhase(tr, at);
      s.energy = sample(tr, 'energy', clamp(at, 0, tr.n * HOP));
      s.vocal = Boolean(item.vocal);
      s.mouth = mouthAt(item.vocal, at) ?? guessMouth(item.meta.id, at, s.energy); // la voix isolée court derrière la lecture
      s.pitch = item.vocal?.pt ? sample(item.vocal, 'pt', clamp(at, 0, item.vocal.n * HOP)) : 0;
    }
    lastAt = at;
    holdUntil = now + 350;
  } else if (now < holdUntil) {
    s.mode = 'speak'; // entre deux phrases : pas d'aller-retour éclair vers « réfléchit »
  } else if (el.caption.textContent && now > captionUntil && now > holdUntil + 1500) {
    caption('');
  }
  lastItem = item;
  if (ptt || performance.now() < followUntil) s.mode = 'listen';
  return s;
}

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

let last = performance.now(), wasAsleep = false;
// Sommeil commandé (« va dormir ») : il s'endort quand il a fini de parler, jusqu'à l'heure dite (8 h au plus).
let pendingSleep = null, sleepUntil = 0;
function goToSleep(until) {
  face.sleep();
  sleepUntil = until;
  store.set('sleepUntil', until);
}
function watchSleep() {
  if (pendingSleep && !player.busy()) {
    if (pendingSleep.turn >= minTurn) goToSleep(pendingSleep.until);
    pendingSleep = null;
  }
  if (face.forced && Date.now() >= sleepUntil) face.wake(); // l'heure : réveil doux, puis le point du matin
  if (!face.forced && sleepUntil) {
    sleepUntil = 0;
    store.set('sleepUntil', 0);
  }
}
// La tenue : selon le genre du morceau chanté (événement « genre »), jamais, ou toujours la même (Réglages).
const notes = new Notes(), clipLooks = new Map();
let ink = settings.color;
function lookFor(song) {
  if (settings.look === 'off') return null;
  if (settings.look !== 'auto') return settings.look;
  return song ? clipLooks.get(song) || null : null;
}
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  const s = sense(now), f = face.update(dt, s);
  f.notes = notes.update(dt, settings.notes && s.mode === 'sing', s.beat);
  f.look = lookFor(s.mode === 'sing' ? s.song : null);
  const nextInk = mixColor(ink, settings.color, 1 - Math.exp(-dt * 3)); // la tenue habille, elle ne repeint pas : Eli garde sa couleur
  if (nextInk !== ink) document.documentElement.style.setProperty('--ink', nextInk); // les paroles et le lecteur prennent sa couleur
  ink = nextInk;
  setInk(ink);
  if (f.gesture === 'meow' && !passive && !MIRROR && player.ready) post('/brain/meow').catch(report);
  sleeper.update(f, settings.snore, face.cat);
  watchSleep();
  if (wasAsleep && !f.asleep) maybeBrief();
  wasAsleep = f.asleep;
  document.body.classList.toggle('asleep', f.asleep);
  fit(el.screen);
  document.body.classList.toggle('listening', s.mode === 'listen' || s.mode === 'think');
  if (now - nowAt > 100) {
    nowAt = now;
    renderNow();
  }
  draw(screenCtx, el.screen.width, el.screen.height, f, dt);
  if (!el.themes.hidden) {
    for (const p of previews) {
      fit(p.canvas);
      p.draw(p.ctx, p.canvas.width, p.canvas.height, f, dt);
    }
  }
  requestAnimationFrame(frame);
}

// --- évènements -----------------------------------------------------------------------------
function unlockAudio() {
  if (passive) takeOver();
  if (player.ready) return;
  player.unlock().then(() => { el.wake.hidden = player.ready; maybeBrief() }, report);
}

const isField = (target) => target instanceof Element && target.matches('input, textarea, select');

addEventListener('pointerdown', () => {
  face.wake();
  unlockAudio();
}, { capture: true });
addEventListener('pointermove', (e) => {
  showDock();
  face.wake(true);
  if (!settings.mouse || e.pointerType === 'touch') return;
  const r = el.screen.getBoundingClientRect();
  mouseGaze = {
    x: clamp((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), -1, 1),
    y: clamp((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2), -1, 1),
  };
});
document.documentElement.addEventListener('mouseleave', () => { mouseGaze = null });
addEventListener('blur', pttEnd);

addEventListener('keydown', (e) => {
  showDock();
  face.wake();
  unlockAudio();
  if (isField(e.target)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) pttStart();
  } else if (e.key === 'Escape') {
    closePanels();
    stopAll('music');
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    cycleTheme(e.key === 'ArrowRight' ? 1 : -1);
  } else if (e.key === 'v' || e.key === 'V') {
    togglePanel(el.themes);
  } else if (e.key === 'm' || e.key === 'M') {
    togglePanel(el.music);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    el.input.focus();
  } else if (e.key === 'p' || e.key === 'P') {
    toggleMusic();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    el.input.focus();
    recall(-1);
  }
});
addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if (!isField(e.target)) e.preventDefault(); // sinon Espace « clique » le bouton qui a le focus
  pttRelease();
});

el.mic.addEventListener('pointerdown', (e) => {
  el.mic.setPointerCapture(e.pointerId);
  pttStart();
});
el.mic.addEventListener('pointerup', pttRelease);
el.mic.addEventListener('pointercancel', pttEnd);
el.mic.addEventListener('contextmenu', (e) => e.preventDefault());

// Les messages envoyés se rappellent avec ↑ / ↓, comme dans un terminal, prêts à renvoyer.
let sent = store.get('sent', []), sentAt = sent.length, draft = '';
function recall(step) {
  const next = sentAt + step;
  if (next < 0 || next > sent.length) return;
  if (sentAt === sent.length) draft = el.input.value;
  sentAt = next;
  el.input.value = next === sent.length ? draft : sent[next];
  requestAnimationFrame(() => el.input.setSelectionRange(el.input.value.length, el.input.value.length));
}
el.input.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing) {
    e.preventDefault();
    recall(e.key === 'ArrowUp' ? -1 : 1);
  }
});

el.chat.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = el.input.value.trim();
  el.input.value = '';
  if (!raw) return;
  if (raw !== sent.at(-1)) {
    sent = [...sent, raw].slice(-100);
    store.set('sent', sent);
  }
  sentAt = sent.length;
  draft = '';
  sendChat(raw);
});

$('#btn-themes').addEventListener('click', () => togglePanel(el.themes));
$('#btn-music').addEventListener('click', () => togglePanel(el.music));
$('#s-music-open').addEventListener('click', () => togglePanel(el.music));
$('#btn-settings').addEventListener('click', () => {
  // dans l'encoche ou le widget, les réglages s'ouvrent dans la fenêtre de l'app
  if (APP && document.body.dataset.layout !== 'window') native({ type: 'open', panel: 'settings' });
  else togglePanel(el.settings);
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => togglePanel(b.closest('.panel'))));
el.wake.addEventListener('click', unlockAudio);

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  el.drop.hidden = false;
});
addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  for (const zone of el.drop.children) zone.classList.toggle('over', zone.contains(e.target));
});
addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    el.drop.hidden = true;
  }
});
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  const zone = e.target instanceof Element ? e.target.closest('[data-kind]') : null;
  const file = e.dataTransfer.files[0];
  unlockAudio();
  if (file) sendFile(file, zone?.dataset.kind || 'speech');
});

// --- un seul écran parle -----------------------------------------------------------------------
// Chaque page est un écran : deux pages (onglets, app Mac, iPhone…) feraient deux voix décalées. Le serveur arbitre :
// la dernière ouverte ou touchée prend la main (POST /take), les autres se taisent (événement « take »).
const wakeLabel = el.wake.querySelector('span');
const claim = () => { if (!MIRROR) post('/take', { client: CLIENT }).catch(() => { /* serveur ancien : pas d'arbitre */ }) };
function takeOver() {
  passive = false;
  wakeLabel.textContent = t('Clique pour réveiller Eli (le son a besoin d’un clic)');
  el.wake.hidden = player.ready;
  claim();
}
function yieldTo() {
  if (passive || MIRROR) return;
  passive = true;
  pttEnd();
  player.stop();
  wakeLabel.textContent = t('Eli parle ailleurs (autre onglet, app ou appareil) : clique pour le reprendre ici');
  el.wake.hidden = Boolean(APP && document.body.dataset.layout !== 'window');
}

// --- mode développeur ------------------------------------------------------------------------------
function setDev(on) {
  settings = { ...settings, dev: on };
  store.set('settings', settings);
  $('#s-dev').checked = on;
  el.devlog.hidden = !on;
  if (on) devlog.openDrawer($('#devlog-list'));
  else devlog.closeDrawer();
}
function copyByHand(text) {
  const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  area.style.cssText = 'position:fixed;top:0;opacity:0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy refused');
}
async function copyDiagnostic() {
  const text = await devlog.diagnostic({
    version: info?.version || '?', app: APP || 'web', layout: document.body.dataset.layout, page: location.pathname,
    navigateur: navigator.userAgent, langue: navigator.language, interface: lang, visage: theme.id, réglages: settings, serveur: info,
  });
  try {
    if (APP) native({ type: 'copy', text });
    else await navigator.clipboard.writeText(text).catch(() => copyByHand(text)); // refusé si la page n'a pas le focus
    toast(t('Diagnostic copié : relis-le, puis colle-le dans l’issue.'));
  } catch {
    toast(t('Copie refusée par le navigateur : ouvre le journal et sélectionne le texte.'));
  }
}

// --- l'app native (Mac, iPhone) pilote la page --------------------------------------------------------
// layout : où est Eli (window, widget, notch, notch-open) ; command : ce que demandent ses menus.
window.eliHost = {
  layout(mode, opts = {}) {
    document.body.dataset.layout = mode;
    for (const k of ['notch', 'ear', 'h', 'top']) if (Number.isFinite(opts[k])) document.body.style.setProperty(`--${k}`, `${opts[k]}px`);
    if (mode !== 'window') {
      closePanels();
    }
  },
  command(name) {
    const act = {
      settings: () => { if (el.settings.hidden) $('#btn-settings').click() },
      faces: () => { if (el.themes.hidden) togglePanel(el.themes) },
      chat: () => el.input.focus(),
      music: toggleMusic,
      library: () => { if (el.music.hidden) togglePanel(el.music) },
      stop: () => stopAll('music'), // « Couper la parole » : le morceau continue
      'stop-music': () => stopAll(),
      prev: () => stepSong('prev'),
      next: () => stepSong('next'),
      dev: () => setDev(!settings.dev),
      report: copyDiagnostic,
    }[name];
    if (act) act();
    else devlog.log('warn', `commande inconnue de l'app : ${name}`);
  },
};
el.input.addEventListener('focus', () => APP && native({ type: 'hold', on: true }));
el.input.addEventListener('blur', () => APP && native({ type: 'hold', on: false }));

// --- langue ------------------------------------------------------------------------------------
// Les noms des tenues se composent (« Toujours : Jazz ») : refaits à chaque changement de langue, le reste se retraduit sur place.
function lookNames() {
  for (const o of $('#s-look').options) if (LOOKS[o.value]) o.text = t('Toujours : {name}', { name: t(LOOKS[o.value].name) });
}
function relang(server) {
  const next = langFor(server);
  if (next === lang) return;
  setLang(next);
  translateDom(document.body);
  lookNames();
  renderInfo();
  renderStatus();
}

// --- démarrage -------------------------------------------------------------------------------
translateDom(document.body);
buildThemes();
bindCustom();
bindSettings();
applyTheme(theme.id, false);
renderStatus();
connect();
claim(); // les autres écrans déjà ouverts se taisent
showDock();
player.unlock().catch(() => { /* le navigateur attend un clic : #wake le demande */ });
setTimeout(() => { if (!passive && !BARE) el.wake.hidden = player.ready }, 800);
if (store.get('sleepUntil', 0) > Date.now()) goToSleep(store.get('sleepUntil', 0)); // rechargé en pleine nuit : il dort encore
requestAnimationFrame(frame);
window.eli = { face, player, mic, frame }; // pour inspecter (et animer un onglet masqué) depuis la console

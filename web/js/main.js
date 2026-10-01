// Eli — la page « écran ». Elle reçoit tout par le protocole (SSE), comme le fera l'ESP32, et sert
// aussi de télécommande : micro, texte, glisser-déposer, choix du visage.
import { HOP, SR, crossed, encodeWav, mouthAt, sample } from './analysis.js';
import { Mic, Player, to16k } from './audio.js';
import { Face } from './face.js';
import { Segmenter } from './hotword.js';
import { Sleeper } from './sleep.js';
import { THEMES, getCustom, setCustom, themeById } from './themes.js';

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
const MAX_PTT_MS = 30000;
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
};
const savedCustom = store.get('custom', {});
setCustom({
  cols: clamp(Math.round((Number(savedCustom.cols) || 40) / 2) * 2, 16, 64),
  shape: savedCustom.shape === 'carre' ? 'carre' : 'perle',
  bg: savedCustom.bg !== false,
});

const el = {
  bezel: $('#bezel'), screen: $('#screen'), caption: $('#caption'), toast: $('#toast'), dock: $('#dock'),
  mic: $('#btn-mic'), chat: $('#chat'), input: $('#chat-input'), status: $('#status'), info: $('#info'),
  themes: $('#panel-themes'), settings: $('#panel-settings'), groups: $('#theme-groups'), custom: $('#custom'),
  drop: $('#drop'), wake: $('#wake'), file: $('#file'), voice: $('#s-voice'), voiceHint: $('#s-voice-hint'),
  mini: $('#mini'), miniPlay: $('#mini-play'), miniIcon: $('#mini-icon'), miniSeek: $('#mini-seek'), miniTime: $('#mini-time'),
};

const face = new Face();
const player = new Player((item) => toast(`Son illisible (${item.meta.name || 'clip'}) : ${item.error?.message || 'format inconnu'}`));
const mic = new Mic(player);
const sleeper = new Sleeper(player);
const screenCtx = el.screen.getContext('2d');
const previews = [];

let theme = themeById(store.get('theme', 'pixel')) || THEMES[0];
let draw = theme.make();
let online = false, info = null, statusText = '';
let serverMode = 'idle', serverGaze = null, mouseGaze = null, minTurn = 0;
let ptt = false, pttTimer = 0, passive = false, moodUntil = 0;
let lastItem = null, lastAt = 0, holdUntil = 0, captionUntil = 0;

// --- messages à l'utilisateur ---------------------------------------------------------------
let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 6000);
}
const report = (err) => toast(err?.message || String(err));

function note(text) {
  statusText = text;
  renderStatus();
}

function renderStatus() {
  el.status.textContent = online ? statusText || 'Prêt' : 'Serveur injoignable…';
  el.status.classList.toggle('off', !online);
}

function caption(text, kind = '', ms = 0) {
  el.caption.textContent = settings.captions ? text : '';
  el.caption.className = `caption ${kind}`;
  captionUntil = ms ? performance.now() + ms : 0;
}

const EARS = { echo: 'Écho (serveur maison)', groq: 'Groq Whisper' };
function renderInfo() {
  if (!info) return;
  const rows = [
    ['Voix', info.tts],
    ['Oreilles', (info.stt || '').split(',').map((p) => EARS[p.trim()] || p.trim()).join(', puis ')],
    ['Cerveau', info.llm || 'pas de clé Groq (il le dira)'],
    ['Chant', info.stems ? 'MDX-Net, voix isolée en direct' : 'modèle de voix absent : il danse sans chanter'],
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
  if (!res.ok) throw new Error(data.error || `le serveur répond ${res.status}`);
  return data;
}

// Le choix de la voix : la liste vient du serveur, qui prévient (événement « voice ») quand il a basculé.
function renderVoices(c) {
  const busy = c.busy ? c.voices.find((v) => v.id === c.busy) : null;
  el.voice.replaceChildren(...c.voices.map((v) => new Option(v.ready ? v.label : `${v.label} (à télécharger)`, v.id)));
  el.voice.value = c.busy || c.current;
  el.voice.disabled = Boolean(busy);
  $('#s-catvoice').checked = Boolean(c.cat);
  el.voiceHint.textContent = busy ? `Je prends la voix ${busy.label.split(' ·')[0]}…` : c.error ? `Raté : ${c.error}` : 'Toutes locales. Les voix Piper se téléchargent au premier choix (~60 Mo).';
}

function connect() {
  const es = new EventSource('/events');
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('hello', (s) => {
    online = true;
    info = s;
    fetch('/api/voices').then((r) => r.json()).then((c) => c.voices && renderVoices(c)).catch(report);
    serverMode = s.mode || 'idle';
    serverGaze = s.gaze || null;
    minTurn = s.turn || 0;
    if (s.theme && s.theme !== theme.id && themeById(s.theme)) applyTheme(s.theme, false);
    else if (s.theme !== theme.id) post('/theme', { id: theme.id, from: CLIENT }).catch(report);
    renderInfo();
    renderStatus();
    maybeIntro();
    maybeBrief();
  });
  on('clip', onClip);
  on('music', renderMusic);
  on('setup', (d) => { if (d.need === 'navidrome') askMusic() });
  on('voice', (c) => {
    renderVoices(c);
    if (!c.busy) fetch('/api/status').then((r) => r.json()).then((s) => { info = s; renderInfo() }).catch(report);
  });
  on('stem', (d) => {
    if (d.error) return toast(`Voix du morceau non isolée : ${d.error}`);
    player.attachStem(d.id, d.url)
      .then((ok) => { if (ok && !d.done) note('') })
      .catch((err) => toast(`Voix isolée illisible : ${err.message}`));
  });
  on('state', (d) => {
    serverMode = d.mode;
    face.wake();
  });
  on('gaze', (d) => { serverGaze = d.gaze });
  on('theme', (d) => { if (d.from !== CLIENT) applyTheme(d.id, false) });
  on('stop', (d) => {
    minTurn = Math.max(minTurn, d.turn || 0);
    player.stop(d.keep || null);
  });
  on('brain', onBrain);
  es.onerror = () => {
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
    note('Réponds-lui : maintiens Espace pour parler, ou écris en bas.');
  }, report);
}

function onClip(meta) {
  if (passive) return;
  if (meta.turn > 0 && meta.turn < minTurn) return; // reste d'une réplique interrompue
  face.wake();
  player.enqueue(meta);
  if (meta.kind === 'music') {
    if (meta.stem === 'off') note('Sans modèle de voix, je danse sans chanter.');
  }
  if (!player.ready) el.wake.hidden = false;
}

function onBrain(d) {
  if (d.stage === 'stt') note('Je transcris…');
  else if (d.stage === 'heard') {
    if (d.text) caption(`« ${d.text} »`, 'you', 8000);
    note(d.text ? 'Je réfléchis…' : 'Je n’ai rien entendu.');
  } else if (d.stage === 'llm') note('Je réfléchis…');
  else if (d.stage === 'music') note(`Je cherche « ${d.text || 'un morceau'} »…`);
  else if (d.stage === 'done') note('');
  else if (d.stage === 'error') toast(`Cerveau en panne : ${d.error}`);
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
  note(`Visage : ${theme.name}`);
}

function buildThemes() {
  for (const family of ['Pixel', 'Chats', 'Trait', 'Autres']) {
    const title = document.createElement('h3'), cards = document.createElement('div');
    title.textContent = family;
    cards.className = 'cards';
    for (const t of THEMES.filter((x) => x.family === family)) {
      const button = document.createElement('button'), canvas = document.createElement('canvas');
      const name = document.createElement('span'), noteEl = document.createElement('span');
      button.type = 'button';
      button.className = 'card';
      button.dataset.screen = t.screen;
      button.setAttribute('aria-pressed', String(t === theme));
      name.className = 'name';
      name.textContent = t.name;
      noteEl.className = 'note';
      noteEl.textContent = t.note;
      button.append(canvas, name, noteEl);
      button.addEventListener('click', () => applyTheme(t.id));
      cards.append(button);
      previews.push({ theme: t, button, canvas, ctx: canvas.getContext('2d'), draw: t.make() });
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
  const lead = $('#s-lead'), leadOut = $('#s-lead-out'), volume = $('#s-volume'), captions = $('#s-captions'), mouse = $('#s-mouse'), snore = $('#s-snore'), hot = $('#s-hotword'), brief = $('#s-brief');
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
  update({});
  if (settings.hotword && !MIRROR) hotword(true);
  hot.addEventListener('change', () => {
    update({ hotword: hot.checked });
    hotword(hot.checked);
  });
  snore.addEventListener('change', () => update({ snore: snore.checked }));
  brief.addEventListener('change', () => update({ brief: brief.checked }));
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
    if (confirm('Effacer la conversation et tous les souvenirs d’Eli ?')) post('/brain/reset?all=1').then(() => { note('J’ai tout oublié.'); loadNotes() }, report);
  });
  el.voice.addEventListener('change', () => post('/voice', { id: el.voice.value }).catch(report));
  $('#s-catvoice').addEventListener('change', (e) => post('/voice', { cat: e.target.checked }).catch(report));
  $('#s-stop').addEventListener('click', () => stopAll('music'));
  $('#s-reset').addEventListener('click', () => post('/brain/reset').then(() => note('Conversation oubliée.'), report));
}

// --- musique (Navidrome) : Eli ouvre ce formulaire tout seul quand on lui demande un morceau sans accès --------
const musicForm = $('#s-music-form');
function renderMusic(m) {
  musicForm.hidden = m.configured;
  $('#s-music-done').hidden = !m.configured;
  $('#s-music-hint').textContent = m.configured
    ? `Connecté à ${m.url} (${m.user}). Demande « Eli, mets du jazz ».`
    : 'Branche ta bibliothèque Navidrome (ou tout serveur Subsonic) et demande « Eli, mets du Daft Punk ». Le mot de passe n’est pas gardé, seulement un jeton.';
  if (!m.configured && m.url) musicForm.url.value = m.url;
}
function askMusic() {
  if (BARE) return;
  if (el.settings.hidden) togglePanel(el.settings);
  const box = $('#s-music');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.classList.remove('ask');
  void box.offsetWidth; // relance l'animation
  box.classList.add('ask');
  (musicForm.hidden ? $('#s-music-forget') : musicForm.url).focus({ preventScroll: true });
  note('Donne-moi l’accès à ta bibliothèque Navidrome.');
}
musicForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = musicForm, btn = f.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Je vérifie…';
  post('/music/setup', { url: f.url.value, user: f.user.value, password: f.password.value })
    .then((m) => { f.password.value = ''; renderMusic(m); note('Bibliothèque branchée.') }, report)
    .finally(() => { btn.disabled = false; btn.textContent = 'Connecter' });
});
$('#s-music-forget').addEventListener('click', () => post('/music/forget').then(renderMusic, report));
fetch('/api/music').then((r) => r.json()).then(renderMusic).catch(report);

// --- panneaux et dock -----------------------------------------------------------------------
function togglePanel(panel) {
  const open = panel.hidden;
  el.themes.hidden = true;
  el.settings.hidden = true;
  panel.hidden = !open;
  showDock();
}

let dockTimer = 0;
function showDock() {
  el.dock.classList.remove('away');
  document.body.classList.remove('calm');
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => {
    const busy = el.dock.matches(':hover, :focus-within') || !el.themes.hidden || !el.settings.hidden || ptt;
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
  post('/stop', keep ? { keep } : undefined).catch(report);
  note('');
}

// --- mini-lecteur (dans le dock) : lecture/pause et position du morceau ---------------------
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let seeking = false, miniAt = 0;
function renderMini() {
  const m = player.ready ? player.music() : null;
  el.mini.hidden = !m;
  if (!m) return;
  const pos = player.position(m), dur = m.buffer.duration, paused = m.paused !== null && m.paused !== undefined;
  if (!seeking) el.miniSeek.value = pos / dur;
  el.miniTime.textContent = `${clock(seeking ? el.miniSeek.value * dur : pos)} / ${clock(dur)}`;
  el.miniIcon.setAttribute('d', paused ? 'M8 5.5v13l11-6.5z' : 'M9 6v12M15 6v12');
  el.miniPlay.setAttribute('aria-label', paused ? 'Lecture' : 'Pause');
}
function toggleMusic() {
  const m = player.music();
  if (m) player.toggle(m);
}
el.miniPlay.addEventListener('click', toggleMusic);
el.miniSeek.addEventListener('input', () => { seeking = true });
el.miniSeek.addEventListener('change', () => {
  seeking = false;
  const m = player.music();
  if (m) player.seek(m, Number(el.miniSeek.value) * m.buffer.duration);
});

async function pttStart() {
  if (ptt) return;
  ptt = true;
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
    note('Je t’écoute… (relâche pour envoyer)');
    pttTimer = setTimeout(pttEnd, MAX_PTT_MS);
  } catch (err) {
    ptt = false;
    el.mic.classList.remove('on');
    toast(micError(err));
  }
}

async function pttEnd() {
  if (!ptt) return;
  ptt = false;
  clearTimeout(pttTimer);
  el.mic.classList.remove('on');
  const buffer = mic.stop();
  if (!buffer || buffer.duration < 0.3) {
    note('Trop court : maintiens Espace (ou le bouton) pendant que tu parles.');
    return;
  }
  serverMode = 'think';
  note('J’envoie…');
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
      note('Oui ? Je t’écoute…');
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
  if (err?.name === 'NotAllowedError') return 'Micro refusé : autorise-le pour cette page (icône dans la barre d’adresse), puis réessaie.';
  if (err?.name === 'NotFoundError') return 'Aucun micro trouvé.';
  return `Micro indisponible : ${err?.message || err}`;
}

async function sendChat(raw) {
  const verbatim = raw.startsWith('>'), text = (verbatim ? raw.slice(1) : raw).trim();
  if (!text) return;
  try {
    if (!verbatim) {
      serverMode = 'think';
      caption(`« ${text} »`, 'you', 8000);
    }
    const { turn } = await post(verbatim ? '/brain/speak' : '/brain/chat', { text });
    minTurn = Math.max(minTurn, turn);
  } catch (err) {
    serverMode = 'idle';
    report(err);
  }
}

async function sendFile(file, kind) {
  if (!file.type.startsWith('audio/') && !AUDIO_FILE.test(file.name)) return toast('Il me faut un fichier audio (wav, mp3, m4a, flac…).');
  if (file.size > MAX_FILE) return toast('Fichier trop gros : 150 Mo maximum.');
  stopAll(); // un son déposé passe devant tout : sinon il attendrait la fin du morceau en cours
  note(kind === 'music' ? 'J’écoute le morceau…' : 'Je prépare le son…');
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
      caption(item.kind === 'music' ? `♪ ${item.meta.name || 'musique'}` : item.meta.text, item.kind);
      if (statusText === 'Je réfléchis…' || statusText === 'J’envoie…') note('');
    }
    if (item.kind === 'speech') {
      s.mode = 'speak';
      s.mouth = mouthAt(tr, at);
      s.phraseStart = crossed(tr.starts, prev, at) >= 0;
      s.pause = crossed(tr.pauses, prev, at) >= 0;
    } else {
      const b = crossed(tr.beats, prev, at);
      s.mode = 'sing';
      if (b >= 0) s.beat = 0.35 + 0.65 * tr.strength[b];
      s.sway = swayPhase(tr, at);
      s.energy = sample(tr, 'energy', clamp(at, 0, tr.n * HOP));
      s.vocal = Boolean(item.vocal);
      s.mouth = item.vocal ? mouthAt(item.vocal, at) : null;
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
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  const f = face.update(dt, sense(now));
  if (f.gesture === 'meow' && !passive && !MIRROR && player.ready) post('/brain/meow').catch(report);
  sleeper.update(f, settings.snore, face.cat);
  if (wasAsleep && !f.asleep) maybeBrief();
  wasAsleep = f.asleep;
  document.body.classList.toggle('asleep', f.asleep);
  fit(el.screen);
  if (now - miniAt > 200) {
    miniAt = now;
    renderMini();
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
  face.wake();
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
    el.themes.hidden = true;
    el.settings.hidden = true;
    stopAll('music');
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    cycleTheme(e.key === 'ArrowRight' ? 1 : -1);
  } else if (e.key === 'v' || e.key === 'V') {
    togglePanel(el.themes);
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
  pttEnd();
});

el.mic.addEventListener('pointerdown', (e) => {
  el.mic.setPointerCapture(e.pointerId);
  pttStart();
});
el.mic.addEventListener('pointerup', pttEnd);
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
$('#btn-settings').addEventListener('click', () => togglePanel(el.settings));
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

// --- un seul onglet parle -------------------------------------------------------------------
// Chaque page est un écran : deux onglets feraient deux voix. Le dernier ouvert ou touché prend la main.
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('eli') : null;
const wakeLabel = el.wake.querySelector('span'), WAKE_TEXT = wakeLabel.textContent;
function takeOver() {
  passive = false;
  wakeLabel.textContent = WAKE_TEXT;
  el.wake.hidden = player.ready;
  tabs?.postMessage('take');
}
tabs?.addEventListener('message', ({ data }) => {
  if (data !== 'take' || passive || MIRROR) return;
  passive = true;
  pttEnd();
  player.stop();
  wakeLabel.textContent = 'Eli parle dans un autre onglet : clique pour le reprendre ici';
  el.wake.hidden = false;
});

// --- démarrage -------------------------------------------------------------------------------
buildThemes();
bindCustom();
bindSettings();
applyTheme(theme.id, false);
renderStatus();
connect();
if (!MIRROR) tabs?.postMessage('take'); // les onglets déjà ouverts se taisent
showDock();
player.unlock().catch(() => { /* le navigateur attend un clic : #wake le demande */ });
setTimeout(() => { if (!passive && !BARE) el.wake.hidden = player.ready }, 800);
requestAnimationFrame(frame);
window.eli = { face, player, mic, frame }; // pour inspecter (et animer un onglet masqué) depuis la console

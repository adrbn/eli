// Le premier lancement : Eli pose ses questions en sous-titres (voix, cerveau, musique, micro) et réagit aux réponses.
// Il ne parle qu'avec une voix choisie et prête, jamais avec celle de secours ; tout se saute et se retrouve dans Réglages.
// Les voix s'écoutent tout de suite (extraits embarqués, samples/) ; seule celle qu'on garde se télécharge, pendant la suite.
import { lang, t } from './i18n.js';

const $ = (s) => document.querySelector(s);
const STEPS = ['voice', 'brain', 'music', 'mic'];

// deps : post, play(clip), react(mood), setLang(l), setHotword(on), music(m), done()
export function initOnboarding(deps) {
  const root = $('#onboard'), next = $('#ob-next'), back = $('#ob-back');
  const state = { step: 0, catalog: null, pick: null, waiting: false, brain: false, music: false, mic: false };
  const samples = fetch('samples/samples.json').then((r) => r.json()).catch(() => null);
  const done = { voice: () => Boolean(state.catalog), brain: () => state.brain, music: () => state.music, mic: () => state.mic };

  const piper = () => (state.catalog?.voices || []).filter((v) => !v.id.startsWith('say:'));
  // la voix choisie : celle cliquée, sinon l'actuelle si c'est une vraie, sinon la première (celle par défaut)
  const pick = () => state.pick || (piper().some((v) => v.id === state.catalog?.current) ? state.catalog.current : piper()[0]?.id);
  const voiceReady = () => {
    const c = state.catalog;
    return Boolean(c && !c.busy && c.current === pick() && c.voices.some((v) => v.id === c.current && v.ready));
  };
  const say = (out, text, kind = '') => { out.textContent = text; out.className = `ob-out ${kind}` };

  function render() {
    const step = STEPS[state.step], ok = done[step]();
    for (const s of root.querySelectorAll('[data-step]')) s.hidden = s.dataset.step !== step;
    root.querySelectorAll('.ob-pips li').forEach((li, i) => li.classList.toggle('on', i <= state.step));
    back.hidden = state.step === 0;
    next.classList.toggle('go', ok); // un seul bouton vert à la fois
    next.disabled = state.waiting;
    next.textContent = state.waiting ? t('Ma voix arrive…')
      : step === 'mic' ? t(ok ? 'C’est parti' : 'Plus tard') : t(ok ? 'Continuer' : 'Plus tard');
    for (const b of root.querySelectorAll('.ob-seg button')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
    renderVoices();
  }

  function renderVoices() {
    const c = state.catalog, box = $('#ob-voices');
    if (!c) return;
    box.replaceChildren(...piper().map((v) => {
      const [name, desc] = v.label.split(' · ');
      const b = document.createElement('button'), n = document.createElement('b'), d = document.createElement('small');
      b.type = 'button';
      b.className = `ob-voice${c.busy === v.id ? ' busy' : ''}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(pick() === v.id));
      b.dataset.id = v.id;
      n.textContent = name;
      d.textContent = c.busy === v.id ? t('je la télécharge') : desc || '';
      b.append(n, d);
      return b;
    }));
    $('#ob-voice-note').textContent = c.error ? t('Raté : {error}', { error: c.error })
      : t('Clique sur une voix pour l’entendre. Elles tournent toutes sur ton Mac.');
  }

  function go(i) {
    state.step = i;
    render();
    const step = root.querySelector(`[data-step="${STEPS[i]}"]`);
    (step.querySelector('input:not([type=checkbox]), .ob-cta') || next).focus({ preventScroll: true });
  }

  function start() {
    if (!root.hidden) return;
    root.hidden = false;
    document.body.classList.add('onboarding');
    go(0);
  }

  // la voix gardée : téléchargée pendant les étapes suivantes (rien à faire si c'est déjà elle)
  function commitVoice() {
    const id = pick(), c = state.catalog;
    if (id && c && id !== c.current && c.busy !== id) deps.post('/voice', { id }).catch((err) => say($('#ob-voice-note'), err.message));
  }

  function finish() {
    if (state.catalog && !voiceReady()) { // il ne parlera qu'avec la voix choisie : on l'attend
      state.waiting = true;
      return render();
    }
    state.waiting = false;
    root.hidden = true;
    document.body.classList.remove('onboarding');
    deps.done();
  }

  // une voix : l'entendre tout de suite de sa bouche (l'extrait), sans rien télécharger
  $('#ob-voices').addEventListener('click', async (e) => {
    const id = e.target.closest('.ob-voice')?.dataset.id;
    if (!id) return;
    state.pick = id;
    render();
    const s = await samples;
    if (s?.phonemes[id]) deps.play({ url: `samples/${id}.m4a`, kind: 'speech', turn: 0, mood: 'joie', text: s.text[lang], phonemes: s.phonemes[id] });
  });
  root.querySelector('.ob-seg').addEventListener('click', (e) => {
    const l = e.target.closest('[data-lang]')?.dataset.lang;
    if (!l || l === lang) return;
    state.pick = null;
    deps.setLang(l);
  });

  // le cerveau : la clé Groq, ou un modèle à soi
  async function brain(body, out, form) {
    say(out, body.groq ? t('Je vérifie la clé…') : t('Je contacte le serveur…'));
    try {
      const s = await deps.post('/key', body);
      state.brain = Boolean(s.llm);
      form.reset();
      say(out, t('Ça y est, je réfléchis avec {model}.', { model: body.groq ? 'Groq' : s.llm }), 'ok');
      deps.react('joie');
      render();
      next.focus();
    } catch (err) {
      say(out, err.message, 'err');
      deps.react('gêne');
    }
  }
  $('#ob-key').addEventListener('submit', (e) => {
    e.preventDefault();
    brain({ groq: e.target.groq.value.trim() }, $('#ob-key-out'), e.target);
  });
  $('#ob-key').groq.addEventListener('paste', (e) => setTimeout(() => e.target.form.requestSubmit())); // coller suffit
  $('#ob-llm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    brain({ llm_url: f.llm_url.value.trim(), llm_model: f.llm_model.value.trim(), llm_key: f.llm_key.value.trim() }, $('#ob-key-out'), f);
  });

  // la musique
  $('#ob-music').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, out = $('#ob-music-out');
    say(out, t('Je contacte le serveur…'));
    try {
      deps.music(await deps.post('/music/setup', { url: f.url.value.trim(), user: f.user.value.trim(), password: f.password.value }));
      f.password.value = '';
      f.closest('details').open = false;
      say(out, t('Bibliothèque branchée. Demande-moi un morceau !'), 'ok');
      deps.react('joie');
      next.focus();
    } catch (err) {
      say(out, err.message, 'err');
      deps.react('gêne');
    }
  });

  // le micro : macOS demande la permission au premier accès
  $('#ob-mic').addEventListener('click', async () => {
    const out = $('#ob-mic-out');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      state.mic = true;
      $('#ob-mic').hidden = true;
      $('#ob-hot-row').hidden = false;
      say(out, t('Je t’entends !'), 'ok');
      deps.react('surprise');
      setTimeout(() => deps.react('joie'), 700);
      render();
      next.focus();
    } catch (err) {
      say(out, t('Micro refusé : {error}. Réglages Système › Confidentialité › Micro.', { error: err.message }), 'err');
      deps.react('tristesse');
    }
  });
  $('#ob-hot').addEventListener('change', (e) => deps.setHotword(e.target.checked));

  // un formulaire déplié sous le pli : on le fait venir plutôt que de laisser chercher
  for (const d of root.querySelectorAll('.ob-more')) d.addEventListener('toggle', () => {
    if (d.open) d.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  next.addEventListener('click', () => {
    if (state.step === 0) commitVoice();
    if (state.step === STEPS.length - 1) finish();
    else go(state.step + 1);
  });
  back.addEventListener('click', () => go(state.step - 1));

  return {
    get open() { return !root.hidden },
    start,
    // les nouvelles du serveur, qui font avancer les étapes
    voices(c) {
      state.catalog = c;
      if (state.waiting && c.error) { state.waiting = false; go(0) } // le téléchargement a raté : on le montre
      else if (state.waiting && voiceReady()) return finish();
      if (!root.hidden) render();
    },
    info(s) { state.brain = Boolean(s?.llm); if (!root.hidden) render() },
    music(m) { state.music = Boolean(m?.configured); if (!root.hidden) render() },
  };
}

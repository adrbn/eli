// Le premier lancement : Eli pose ses questions en sous-titres (voix, cerveau, musique, micro) et réagit aux réponses.
// Il ne parle qu'avec une voix choisie et prête, jamais avec celle de secours ; tout se saute et se retrouve dans Réglages.
import { lang, t } from './i18n.js';

const $ = (s) => document.querySelector(s);
const STEPS = ['voice', 'brain', 'music', 'mic'];

// deps : post, speak(text), react(mood), setLang(l), setHotword(on), music(m), done()
export function initOnboarding(deps) {
  const root = $('#onboard'), next = $('#ob-next'), back = $('#ob-back');
  const state = { step: 0, catalog: null, sample: null, brain: false, music: false, mic: false };
  const done = { voice: () => voiceReady(), brain: () => state.brain, music: () => state.music, mic: () => state.mic };

  const voiceReady = () => {
    const c = state.catalog;
    return Boolean(c && !c.busy && c.voices.some((v) => v.id === c.current && v.ready && !v.id.startsWith('say:')));
  };
  const say = (out, text, kind = '') => { out.textContent = text; out.className = `ob-out ${kind}` };

  function render() {
    const step = STEPS[state.step], ok = done[step]();
    for (const s of root.querySelectorAll('[data-step]')) s.hidden = s.dataset.step !== step;
    root.querySelectorAll('.ob-pips li').forEach((li, i) => li.classList.toggle('on', i <= state.step));
    back.hidden = state.step === 0;
    next.hidden = step === 'voice' && !ok; // la voix d'abord : sans elle il ne parlera pas
    next.classList.toggle('go', ok); // un seul bouton vert à la fois
    next.textContent = step === 'mic' ? t(ok ? 'C’est parti' : 'Plus tard') : t(ok ? 'Continuer' : 'Plus tard');
    for (const b of root.querySelectorAll('.ob-seg button')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
    renderVoices();
  }

  function renderVoices() {
    const c = state.catalog, box = $('#ob-voices');
    if (!c) return;
    box.replaceChildren(...c.voices.filter((v) => !v.id.startsWith('say:')).map((v) => {
      const [name, desc] = v.label.split(' · ');
      const b = document.createElement('button'), n = document.createElement('b'), d = document.createElement('small');
      b.type = 'button';
      b.className = `ob-voice${c.busy === v.id ? ' busy' : ''}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String((c.busy || c.current) === v.id));
      b.dataset.id = v.id;
      n.textContent = name;
      d.textContent = c.busy === v.id ? t('je la télécharge') : v.ready ? desc || '' : t('{desc} · ~60 Mo', { desc: desc || '' });
      b.append(n, d);
      return b;
    }));
    $('#ob-voice-note').textContent = c.error ? t('Raté : {error}', { error: c.error })
      : c.busy ? t('Je télécharge ma voix (~60 Mo), je ne parlerai qu’avec elle…')
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

  function finish() {
    root.hidden = true;
    document.body.classList.remove('onboarding');
    deps.done();
  }

  // une voix : la choisir (téléchargée si besoin), puis l'entendre de sa bouche
  $('#ob-voices').addEventListener('click', (e) => {
    const id = e.target.closest('.ob-voice')?.dataset.id, c = state.catalog;
    if (!id || c?.busy) return;
    state.sample = id;
    if (id === c.current) hear();
    else deps.post('/voice', { id }).catch((err) => say($('#ob-voice-note'), err.message));
  });
  function hear() {
    state.sample = null;
    deps.speak(t('Salut ! Moi c’est Eli. Elle te plaît, cette voix ?'));
  }
  root.querySelector('.ob-seg').addEventListener('click', (e) => {
    const l = e.target.closest('[data-lang]')?.dataset.lang;
    if (l && l !== lang) deps.setLang(l);
  });

  // le cerveau : la clé Groq, ou un modèle à soi
  async function brain(body, out, form) {
    say(out, body.groq ? t('Je vérifie la clé…') : t('Je contacte le serveur…'));
    try {
      const s = await deps.post('/key', body);
      state.brain = Boolean(s.llm);
      form.reset();
      say(out, t('Ça y est, je réfléchis avec {model}.', { model: s.llm }), 'ok');
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
  next.addEventListener('click', () => (state.step === STEPS.length - 1 ? finish() : go(state.step + 1)));
  back.addEventListener('click', () => go(state.step - 1));

  return {
    get open() { return !root.hidden },
    start,
    // les nouvelles du serveur, qui font avancer les étapes
    voices(c) {
      state.catalog = c;
      if (state.sample && c.current === state.sample && !c.busy) hear();
      if (!root.hidden) render();
    },
    info(s) { state.brain = Boolean(s?.llm); if (!root.hidden) render() },
    music(m) { state.music = Boolean(m?.configured); if (!root.hidden) render() },
  };
}

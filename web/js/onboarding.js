// Le premier lancement : langue et voix, cerveau, musique, micro. Eli ne dit rien avant la fin, et jamais avec la voix de secours.
// Les formulaires sont ceux des Réglages et de la Musique, prêtés le temps de l'accueil puis remis à leur place.
import { t } from './i18n.js';

const $ = (s) => document.querySelector(s);
const STEPS = ['voice', 'brain', 'music', 'mic'];
const LENT = {
  voice: () => [$('#s-lang').closest('.item'), $('#s-voice').closest('.item')],
  brain: () => [$('#s-key'), $('#s-llm')],
  music: () => [$('#m-connect')],
  mic: () => [$('#s-hotword').closest('.item')],
};

export function initOnboarding({ speak, done }) {
  const root = $('#onboard'), next = $('#ob-next'), back = $('#ob-back'), hint = $('#ob-hint');
  const state = { step: -1, voiceReady: false, brain: false, music: false, mic: false };
  let homes = [];

  function render() {
    const step = STEPS[state.step];
    for (const s of root.querySelectorAll('[data-step]')) s.hidden = s.dataset.step !== step;
    for (const [i, dot] of [...root.querySelectorAll('.ob-dots i')].entries()) dot.classList.toggle('on', i <= state.step);
    back.hidden = state.step === 0;
    $('#ob-music-ok').hidden = !state.music;
    $('#ob-mic-out').textContent = state.mic ? t('Micro prêt.') : '';
    const ok = { voice: state.voiceReady, brain: state.brain, music: state.music, mic: true }[step];
    next.disabled = step === 'voice' && !ok;
    next.textContent = step === 'mic' ? t('C’est parti') : ok ? t('Continuer') : t('Plus tard');
    hint.textContent = step === 'voice' && !ok ? t('Sa voix se télécharge (~60 Mo), il ne parlera qu’avec elle…') : '';
  }

  function go(i) {
    state.step = i;
    render();
    root.querySelector('.ob-card').scrollTop = 0;
    root.querySelector(`[data-step="${STEPS[i]}"] :is(input, select, button)`)?.focus({ preventScroll: true });
  }

  function open() {
    if (!root.hidden) return;
    homes = Object.entries(LENT).flatMap(([step, nodes]) => nodes().map((node) => {
      const home = { node, parent: node.parentNode, before: node.nextSibling };
      root.querySelector(`[data-step="${step}"] .ob-slot`).append(node);
      return home;
    }));
    root.hidden = false;
    go(0);
  }

  function finish() {
    for (const { node, parent, before } of homes) parent.insertBefore(node, before);
    homes = [];
    root.hidden = true;
    done();
  }

  next.addEventListener('click', () => (state.step === STEPS.length - 1 ? finish() : go(state.step + 1)));
  back.addEventListener('click', () => go(state.step - 1));
  $('#ob-listen').addEventListener('click', () => speak(t('Salut ! Moi c’est Eli. Tu m’entends bien ?')));
  $('#ob-mic').addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      state.mic = true;
    } catch (err) {
      $('#ob-mic-out').textContent = t('Micro refusé : {error}', { error: err.message });
      return;
    }
    render();
  });

  return {
    get open() { return !root.hidden },
    start: open,
    // les nouvelles du serveur, qui débloquent les étapes
    voices(c) {
      state.voiceReady = !c.busy && c.voices.some((v) => v.id === c.current && v.ready);
      $('#ob-listen').disabled = !state.voiceReady;
      if (!root.hidden) render();
    },
    info(s) { state.brain = Boolean(s?.llm); if (!root.hidden) render() },
    music(m) { state.music = Boolean(m?.configured); if (!root.hidden) render() },
  };
}

// Le panneau Musique : choisir un morceau dans la bibliothèque Navidrome (ou tout serveur Subsonic), et gérer ce serveur.
// Le serveur d'Eli fait l'intermédiaire (/api/music/songs, /music/cover, /music/play) : le jeton Subsonic ne quitte jamais la machine.
import { t } from './i18n.js';

const $ = (s) => document.querySelector(s);
const clock = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

export function initLibrary({ post, note, report, stopAll }) {
  const form = $('#m-connect'), list = $('#m-songs'), q = $('#m-q'), out = $('#m-ping');
  let status = { configured: false }, timer = 0, asked = 0;

  async function search() {
    const ask = ++asked;
    list.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(`/api/music/songs?q=${encodeURIComponent(q.value.trim())}`);
      const data = await res.json().catch(() => ({}));
      if (ask !== asked) return; // une frappe plus récente a déjà relancé
      if (!res.ok) throw new Error(data.error || t('le serveur répond {status}', { status: res.status }));
      renderSongs(data.songs || []);
    } catch (err) {
      if (ask === asked) list.dataset.empty = t('Bibliothèque injoignable : {error}', { error: err.message });
      if (ask === asked) list.replaceChildren();
    } finally {
      if (ask === asked) list.removeAttribute('aria-busy');
    }
  }

  function renderSongs(songs) {
    list.dataset.empty = q.value.trim() ? t('Rien de tel dans ta bibliothèque.') : t('Bibliothèque vide.');
    list.replaceChildren(...songs.map((s) => {
      const li = document.createElement('li'), btn = document.createElement('button'), img = document.createElement('img');
      const text = document.createElement('span'), b = document.createElement('b'), small = document.createElement('small'), time = document.createElement('time');
      btn.type = 'button';
      img.alt = '';
      img.loading = 'lazy';
      if (s.cover) img.src = `/music/cover/${encodeURIComponent(s.cover)}`;
      img.onerror = () => img.removeAttribute('src');
      b.textContent = s.title;
      small.textContent = [s.artist, s.album].filter(Boolean).join(' · ');
      time.textContent = clock(s.duration);
      text.append(b, small);
      btn.append(img, text, time);
      btn.addEventListener('click', () => play(s));
      li.append(btn);
      return li;
    }));
  }

  function play(song) {
    // le morceau en cours et la parole : la nouvelle chanson part seule, une fois le /stop passé (sinon il l'annulerait)
    stopAll().then(() => post('/music/play', { id: song.id })).catch(report);
    note(t('Je télécharge « {q} »…', { q: song.title }));
  }

  function render(m) {
    status = m;
    form.hidden = m.configured;
    $('#m-library').hidden = !m.configured;
    $('#m-server').hidden = !m.configured;
    if (m.configured) {
      $('#m-url').textContent = m.url;
      $('#m-user').textContent = m.user;
      $('#m-kind').textContent = m.server || '—';
      out.textContent = '';
    } else if (m.url) form.url.value = m.url;
  }

  // Ouvrir le panneau : la liste se remplit (des morceaux au hasard si rien n'est tapé) ; sans serveur, le formulaire attend.
  function opened() {
    if (status.configured) {
      if (!list.childElementCount) search();
      q.focus({ preventScroll: true });
    } else form.url.focus({ preventScroll: true });
  }

  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 300);
  });
  $('#m-shuffle').addEventListener('click', () => { q.value = ''; search() });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = t('Je vérifie…');
    post('/music/setup', { url: form.url.value, user: form.user.value, password: form.password.value })
      .then((m) => { form.password.value = ''; render(m); note(t('Bibliothèque branchée.')); opened() }, report)
      .finally(() => { btn.disabled = false; btn.textContent = t('Connecter') });
  });
  $('#m-test').addEventListener('click', () => {
    out.textContent = t('Je vérifie…');
    post('/music/ping')
      .then((r) => { out.textContent = t('Répond en {ms} ms', { ms: r.ms }); $('#m-kind').textContent = r.server || '—' })
      .catch((err) => { out.textContent = t('Injoignable : {error}', { error: err.message }) });
  });
  $('#m-forget').addEventListener('click', () => post('/music/forget').then((m) => { list.replaceChildren(); render(m) }, report));
  fetch('/api/music').then((r) => r.json()).then(render).catch(report);

  return { render, opened, configured: () => status.configured };
}

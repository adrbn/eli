// La bouche suit ce que l'oreille entend : chaque clip est analysé en entier avant d'être joué, puis l'image
// est calée sur l'horloge audio, au moment où le son sort vraiment des haut-parleurs (latence de sortie déduite).
import { SR, visemeTrack } from './analysis.js';
import { t } from './i18n.js';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const jobs = new Map();
let jobId = 0;
worker.onmessage = ({ data }) => {
  const job = jobs.get(data.id);
  jobs.delete(data.id);
  if (data.error) job?.reject(new Error(data.error));
  else job?.resolve(data.track);
};
worker.onerror = (event) => {
  for (const job of jobs.values()) job.reject(new Error(event.message || t('analyse impossible')));
  jobs.clear();
};

function analyze(kind, x, minRef, pitch = false) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, kind, x, minRef, pitch }, [x.buffer]);
  });
}

// Ramène n'importe quel son à 16 kHz mono, la cadence d'analyse (et celle qu'attend la transcription).
export async function to16k(buffer) {
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * SR)), SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

export class Player {
  constructor(onError) {
    this.onError = onError;
    this.ctx = null;
    this.gain = null;
    this.volume = 1;
    this.pending = []; // en cours de chargement / d'analyse, dans l'ordre d'arrivée
    this.playing = []; // programmés sur l'horloge audio
    this.cursor = 0; // fin du dernier clip programmé
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get ready() {
    return this.ctx?.state === 'running';
  }

  async unlock() {
    await this.ensure().resume();
    this.pump();
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  // Le temps de l'horloge audio qu'on est en train d'entendre.
  heard() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return Math.min(ctx.currentTime, ts.contextTime + (performance.now() - ts.performanceTime) / 1000);
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  enqueue(meta) {
    const item = { meta, kind: meta.kind, state: 'loading', buffer: null, track: null, vocal: null };
    this.pending.push(item);
    this.load(item)
      .then(() => { item.state = 'ready' }, (err) => { item.state = 'failed'; item.error = err })
      .finally(() => this.pump());
    return item;
  }

  async decode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('son introuvable ({status})', { status: res.status }));
    return this.ensure().decodeAudioData(await res.arrayBuffer());
  }

  async load(item) {
    item.buffer = await this.decode(item.meta.url) // ALAC & co : le serveur le convertit en MP3
      .catch(() => this.decode(`${item.meta.url}?compat=1`));
    item.track = await analyze(item.kind, await to16k(item.buffer));
    if (item.meta.phonemes) Object.assign(item.track, visemeTrack(item.meta.phonemes, item.track.n));
  }

  // Programme les clips prêts, strictement dans l'ordre : un clip lent à charger retient ceux d'après.
  pump() {
    if (!this.ready) return;
    while (this.pending.length && this.pending[0].state !== 'loading') {
      const item = this.pending.shift();
      if (item.state === 'failed') this.onError(item);
      else this.schedule(item);
    }
  }

  schedule(item) {
    const ctx = this.ctx, src = ctx.createBufferSource();
    const gap = this.cursor > ctx.currentTime ? (item.kind === 'speech' ? 0.06 : 0.4) : 0;
    item.t0 = Math.max(ctx.currentTime + 0.06, this.cursor + gap);
    item.end = item.t0 + item.buffer.duration;
    this.cursor = item.end;
    src.buffer = item.buffer;
    src.connect(this.gain);
    src.start(item.t0);
    item.src = src;
    this.playing.push(item);
  }

  // Le clip entendu au temps h (horloge audio) ; oublie ceux qui sont finis.
  at(h) {
    while (this.playing.length && this.playing[0].end < h - 1) this.playing.shift();
    return this.playing.find((i) => h >= i.t0 && h < i.end) || null;
  }

  busy() {
    return this.pending.length > 0 || (this.ctx !== null && this.cursor > this.ctx.currentTime);
  }

  // keep = 'music' : coupe la parole mais laisse le morceau en cours.
  stop(keep = null) {
    const kept = (i) => keep !== null && i.kind === keep;
    for (const item of this.playing) if (!kept(item)) halt(item);
    this.playing = this.playing.filter(kept);
    this.pending = this.pending.filter(kept);
    this.recount();
  }

  // --- mini-lecteur : le dernier morceau programmé, en pause ou non --------------------------
  music() {
    return this.playing.findLast((i) => i.kind === 'music') || null;
  }

  position(item) {
    const d = item.buffer.duration;
    return item.paused ?? Math.min(d, Math.max(0, this.heard() - item.t0));
  }

  // Reprend (ou met en pause, play = false) le morceau à `offset` secondes : une nouvelle source part de là.
  seek(item, offset, play = item.paused === null || item.paused === undefined) {
    halt(item);
    offset = Math.min(item.buffer.duration - 0.05, Math.max(0, offset));
    if (play) {
      const src = this.ctx.createBufferSource(), when = this.ctx.currentTime + 0.05;
      src.buffer = item.buffer;
      src.connect(this.gain);
      src.start(when, offset);
      Object.assign(item, { src, paused: null, t0: when - offset, end: when - offset + item.buffer.duration });
    } else {
      Object.assign(item, { paused: offset, t0: Infinity, end: Infinity }); // invisible pour at() : la bouche se tait
    }
    this.recount();
  }

  toggle(item) {
    this.seek(item, this.position(item), item.paused !== null && item.paused !== undefined);
  }

  recount() {
    this.cursor = Math.max(0, ...this.playing.map((i) => i.end).filter(Number.isFinite));
  }

  // La voix isolée d'un morceau arrive après coup, bloc par bloc : à chaque bloc, on recharge la voix partielle
  // (silence là où elle n'est pas encore calculée) et la bouche chante sur ce qui est déjà là.
  async attachStem(id, url) {
    const item = [...this.pending, ...this.playing].find((i) => i.meta.id === id);
    if (!item) return false;
    const seq = (item.stemSeq || 0) + 1;
    item.stemSeq = seq;
    const res = await fetch(url);
    if (!res.ok) throw new Error(t('voix isolée introuvable ({status})', { status: res.status }));
    const pcm = new Int16Array(await res.arrayBuffer(), 44); // WAV 16 bits mono 16 kHz, en-tête de 44 octets
    const x = Float32Array.from(pcm, (v) => v / 32768);
    const minRef = item.track?.level === undefined ? undefined : item.track.level - 12;
    const vocal = await analyze('speech', x, minRef, true);
    if (seq !== item.stemSeq) return false; // un bloc plus récent est déjà passé
    item.vocal = vocal;
    return this.pending.includes(item) || this.playing.includes(item); // coupé entre-temps : rien à annoncer
  }
}

function halt(item) {
  try {
    item.src.stop();
  } catch {
    // déjà terminé
  }
}

// Micro en « appuyer pour parler ». Le flux reste ouvert 30 s après usage pour ne pas rater le début du suivant.
// ponytail: ScriptProcessor (déprécié mais présent partout) ; passer à un AudioWorklet si un navigateur le retire.
export class Mic {
  constructor(player) {
    this.player = player;
    this.stream = null;
    this.chunks = null;
    this.level = 0;
    this.closeTimer = 0;
    this.taps = new Set(); // écoute permanente : reçoit chaque bloc (échantillons, niveau), garde le micro ouvert
  }

  async start() {
    await this.open();
    this.chunks = [];
  }

  async open() {
    clearTimeout(this.closeTimer);
    const ctx = this.player.ensure();
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.src = ctx.createMediaStreamSource(this.stream);
      this.node = ctx.createScriptProcessor(4096, 1, 1);
      this.mute = ctx.createGain();
      this.mute.gain.value = 0; // le nœud doit être relié à la sortie pour tourner, mais sans s'entendre
      this.src.connect(this.node);
      this.node.connect(this.mute);
      this.mute.connect(ctx.destination);
      this.node.onaudioprocess = (event) => {
        const x = event.inputBuffer.getChannelData(0);
        let s = 0;
        for (let i = 0; i < x.length; i++) s += x[i] * x[i];
        this.level = Math.min(1, Math.max(0, (10 * Math.log10(s / x.length + 1e-12) + 60) / 45));
        if (this.chunks) this.chunks.push(x.slice());
        for (const tap of this.taps) tap(x, this.level);
      };
    }
  }

  // Arrête l'enregistrement : un AudioBuffer prêt à convertir, ou null si rien n'a été capté.
  stop() {
    const chunks = this.chunks;
    this.chunks = null;
    this.level = 0;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.close(), 30000);
    const n = chunks ? chunks.reduce((a, c) => a + c.length, 0) : 0;
    return n ? this.buffer(chunks) : null;
  }

  buffer(chunks) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const buffer = this.player.ensure().createBuffer(1, n, this.player.ctx.sampleRate), out = buffer.getChannelData(0);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return buffer;
  }

  close() {
    if (!this.stream || this.taps.size) return;
    this.stream.getTracks().forEach((t) => t.stop());
    this.src.disconnect();
    this.node.disconnect();
    this.mute.disconnect();
    this.stream = null;
  }
}

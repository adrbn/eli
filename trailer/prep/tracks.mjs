// Eli's lips for each line, sampled at the video's frame rate with the app's own analysis (web/js/analysis.js).
import { readFileSync, writeFileSync } from 'node:fs';
import { SR, analyzeSpeech, mouthAt, visemeTrack } from '../../web/js/analysis.js';

const FPS = 30, dir = new URL('../public/voice/', import.meta.url), out = {};
for (const key of ['hi', 'eli', 'sing', 'night']) {
  const buf = readFileSync(new URL(`${key}.wav`, dir)), rate = buf.readUInt32LE(24), pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
  const n = Math.floor(pcm.length * SR / rate), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * rate / SR, k = Math.floor(p), f = p - k; x[i] = ((pcm[k] || 0) * (1 - f) + (pcm[k + 1] || 0) * f) / 32768 }
  const track = analyzeSpeech(x);
  Object.assign(track, visemeTrack(JSON.parse(readFileSync(new URL(`${key}.json`, dir))), track.n));
  const dur = pcm.length / rate, frames = [];
  for (let i = 0; i < Math.ceil(dur * FPS); i++) {
    const m = mouthAt(track, i / FPS) || { o: 0, w: 0.3, r: 0, t: 0 };
    frames.push([m.o, m.w, m.r, m.t].map((v) => Math.round(v * 1000) / 1000));
  }
  out[key] = { dur, frames };
  console.log(key, dur.toFixed(2), frames.length);
}
writeFileSync(new URL('../src/data/voice.json', import.meta.url), JSON.stringify(out));

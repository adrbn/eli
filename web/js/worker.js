// L'analyse d'un morceau entier prend ~1 s de calcul : hors du fil principal pour ne pas figer le visage.
import { analyzeMusic, analyzeSpeech } from './analysis.js';

onmessage = ({ data: { id, kind, x, minRef, pitch } }) => {
  try {
    const track = kind === 'music' ? analyzeMusic(x) : analyzeSpeech(x, minRef, pitch);
    postMessage({ id, track });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};

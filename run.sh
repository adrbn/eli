#!/usr/bin/env bash
# Lance Eli : le serveur local, puis ouvre la page du visage (sauf avec --no-open).
set -euo pipefail
cd "$(dirname "$0")"

VOICE=voices/fr_FR-siwis-medium.onnx
if [ ! -f "$VOICE" ]; then
  echo "Téléchargement de la voix Piper fr_FR-siwis-medium (~60 Mo)…"
  mkdir -p voices
  base=https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium
  curl -fL "$base/fr_FR-siwis-medium.onnx.json" -o "$VOICE.json"
  curl -fL "$base/fr_FR-siwis-medium.onnx" -o "$VOICE.part" && mv "$VOICE.part" "$VOICE"
fi

# Le chant : seul le modèle par défaut se télécharge. SEPARATOR_MODEL=off dans .env = pas de chant, rien à télécharger.
SEP=voices/Kim_Vocal_2.onnx
WANT="${SEPARATOR_MODEL:-$(sed -n 's/^SEPARATOR_MODEL=//p' .env 2>/dev/null | tail -1)}"
if [ "${WANT:-$SEP}" = "$SEP" ] && [ ! -f "$SEP" ]; then
  echo "Téléchargement du modèle qui isole la voix des morceaux (~65 Mo)…"
  curl -fL https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx -o "$SEP.part" && mv "$SEP.part" "$SEP"
fi

PORT="${PORT:-$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1)}"
PORT="${PORT:-5280}"
# Un onglet d'Eli est déjà ouvert (il se reconnecte tout seul) : en ouvrir un autre ferait taire le premier.
has_page() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" 2>/dev/null | grep -q '"pages": [1-9]'; }
if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/status"; then
  echo "Eli tourne déjà sur le port $PORT."
  if [ "${1:-}" != "--no-open" ] && ! has_page; then open "http://127.0.0.1:$PORT"; fi
  exit 0
fi
if [ "${1:-}" != "--no-open" ]; then
  ( for _ in $(seq 30); do curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/status" && break; sleep 1; done
    sleep 5 # EventSource retente toutes les 3 s
    has_page || open "http://127.0.0.1:$PORT" ) &
fi
exec uv run --quiet python server/app.py

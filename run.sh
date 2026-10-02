#!/usr/bin/env bash
# Lance Eli : le serveur local, puis ouvre la page du visage (sauf avec --no-open).
set -euo pipefail
cd "$(dirname "$0")"

# Les modèles (voix ~60 Mo, chant ~65 Mo, mot de réveil ~40 Mo) : le serveur les télécharge lui-même au besoin.
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

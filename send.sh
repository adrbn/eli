#!/usr/bin/env bash
# Pilote Eli depuis le terminal, avec le même protocole que l'ESP32 plus tard.
#   ./send.sh dis "Bonjour !"         le dit tel quel
#   ./send.sh demande "Ça va ?"       pose la question au LLM, il répond à voix haute
#   ./send.sh parle voix.wav          joue un fichier, la bouche suit
#   ./send.sh chante morceau.mp3      danse sur le tempo et chante (voix isolée par Demucs)
#   ./send.sh regarde 0.6 -0.2        oriente le regard (x, y entre -1 et 1) ; sans valeurs : regard libre
#   ./send.sh visage trait-neon       change de visage
#   ./send.sh humeur think            fond : idle, listen ou think
#   ./send.sh stop                    coupe la parole
#   ./send.sh oublie                  efface la conversation
set -euo pipefail
URL="${ELI_URL:-http://127.0.0.1:5280}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
json() { python3 -c 'import json, sys; a = sys.argv[1:]; print(json.dumps({a[i]: a[i + 1] for i in range(0, len(a), 2)}))' "$@"; }
post() { curl -fsS -X POST "$URL$1" "${@:2}"; echo; }
post_json() { post "$1" -H 'Content-Type: application/json' --data-binary "$2"; }
post_file() {
  [ -f "$2" ] || { echo "fichier introuvable : $2" >&2; exit 1; }
  local name; name=$(python3 -c 'import sys, urllib.parse, os; print(urllib.parse.quote(os.path.basename(sys.argv[1])))' "$2")
  post "/clip?kind=$1&name=$name" -H "Content-Type: $(file -b --mime-type "$2")" --data-binary "@$2"
}

[ $# -ge 1 ] || usage
case "$1" in
  dis)     [ $# -ge 2 ] || usage; post_json /brain/speak "$(json text "$2")" ;;
  demande) [ $# -ge 2 ] || usage; post_json /brain/chat "$(json text "$2")" ;;
  parle)   [ $# -ge 2 ] || usage; post_file speech "$2" ;;
  chante)  [ $# -ge 2 ] || usage; post_file music "$2" ;;
  regarde)
    if [ $# -ge 3 ]; then post_json /gaze "$(python3 -c 'import json, sys; print(json.dumps({"x": float(sys.argv[1]), "y": float(sys.argv[2])}))' "$2" "$3")"
    else post_json /gaze '{}'; fi ;;
  visage)  [ $# -ge 2 ] || usage; post_json /theme "$(json id "$2")" ;;
  humeur)  [ $# -ge 2 ] || usage; post_json /state "$(json mode "$2")" ;;
  stop)    post /stop ;;
  oublie)  post /brain/reset ;;
  *) usage ;;
esac

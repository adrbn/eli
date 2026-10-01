#!/bin/sh
# Container start: checks the volumes, fetches the models run.sh would fetch (first start only), then runs Eli.
set -eu
cd /app

for dir in voices memory cache local; do
  if [ ! -w "$dir" ]; then
    echo "eli: $dir/ is not writable by uid $(id -u). On the host: mkdir -p voices memory cache local, then" \
         "chown them to that uid (or set ELI_UID/ELI_GID in .env to your own ids)." >&2
    exit 1
  fi
done

fetch() {  # url dest
  [ -f "$2" ] && return 0
  echo "eli: downloading $2"
  curl -fL --retry 3 "$1" -o "$2.part" && mv "$2.part" "$2"
}

# The Piper voice must be there before start: without it Eli falls back to macOS `say`, which Linux lacks.
piper=https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium
fetch "$piper/fr_FR-siwis-medium.onnx.json" voices/fr_FR-siwis-medium.onnx.json
fetch "$piper/fr_FR-siwis-medium.onnx" voices/fr_FR-siwis-medium.onnx

# Singing: only the default model is fetched. SEPARATOR_MODEL=off (or any missing path) turns singing off.
if [ "${SEPARATOR_MODEL:-voices/Kim_Vocal_2.onnx}" = "voices/Kim_Vocal_2.onnx" ]; then
  fetch https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx voices/Kim_Vocal_2.onnx
fi

exec "$@"

#!/usr/bin/env bash
# Builds the small ffmpeg + ffprobe the Mac app ships (build/ffmpeg/bin): audio only, LGPL (no --enable-gpl),
# static, no system library. Eli only needs it to read songs (singing, tags, the rare file Chrome can't decode).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=8.0
SHA256=b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e
OUT=build/ffmpeg
[ -x "$OUT/bin/ffmpeg" ] && [ -x "$OUT/bin/ffprobe" ] && [ -f "$OUT/COPYING.LGPLv2.1" ] && { echo "ffmpeg already built: $OUT/bin"; exit 0; }
mkdir -p build
SRC="build/ffmpeg-$VERSION"
if [ ! -d "$SRC" ]; then
  [ -f "build/ffmpeg-$VERSION.tar.xz" ] || curl -fL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "build/ffmpeg-$VERSION.tar.xz"
  echo "$SHA256  build/ffmpeg-$VERSION.tar.xz" | shasum -a 256 -c -
  tar -xf "build/ffmpeg-$VERSION.tar.xz" -C build
  rm "build/ffmpeg-$VERSION.tar.xz"
fi
PREFIX="$(pwd)/$OUT"
cd "$SRC"
./configure --prefix="$PREFIX" --arch=arm64 --cc=clang \
  --extra-cflags=-mmacosx-version-min=13.0 --extra-ldflags=-mmacosx-version-min=13.0 \
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
  --disable-ffplay --disable-avdevice --disable-swscale \
  --enable-protocol=file,pipe \
  --enable-demuxer=mp3,mov,flac,ogg,wav,w64,aiff,aac,caf,matroska \
  --enable-decoder=mp3,mp3float,mp2,aac,alac,flac,vorbis,opus,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_f32be,pcm_u8 \
  --enable-parser=mpegaudio,aac,flac,vorbis,opus \
  --enable-encoder=aac,pcm_f32le,pcm_s16le \
  --enable-muxer=ipod,mp4,pcm_f32le,pcm_s16le,wav,null \
  --enable-bsf=aac_adtstoasc \
  --enable-filter=abuffer,abuffersink,aresample,aformat,anull
make -j"$(sysctl -n hw.ncpu)"
make install
cp COPYING.LGPLv2.1 "$PREFIX/"
cd - >/dev/null
rm -rf "$SRC" "$OUT/include" "$OUT/lib" "$OUT/share"
"$OUT/bin/ffmpeg" -hide_banner -version | head -1
echo "Built $(pwd)/$OUT/bin"

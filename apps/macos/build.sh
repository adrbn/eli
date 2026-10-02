#!/usr/bin/env bash
# Builds build/Eli.app with swiftc (no Xcode project) and signs it with your Developer ID (hardened runtime).
#   ./build.sh            development: the app runs the repo's server (run.sh, uv)
#   BUNDLE=1 ./build.sh   release: Python and its packages, server/, web/ and a small ffmpeg inside the app
# VERSION=0.1.0 BUILD=12 stamp the version. TEAM=XXXXXXXXXX for another team; SIGN_ID=- for an ad-hoc signature
# (the mic permission may not stick, and Sparkle can't update an ad-hoc app).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../.. && pwd)"
TEAM="${TEAM:-2TWQF4T93E}"
APP=build/Eli.app
SPARKLE_VERSION=2.10.0
SPARKLE_SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
PYTHON=3.12  # a relocatable python-build-standalone, as uv installs it

# Sparkle: the framework the app links, and the tools that sign releases (build/sparkle/bin)
if [ ! -d build/sparkle/Sparkle.framework ]; then
  mkdir -p build/sparkle
  curl -fL "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" -o build/sparkle.tar.xz
  echo "$SPARKLE_SHA256  build/sparkle.tar.xz" | shasum -a 256 -c -
  tar -xf build/sparkle.tar.xz -C build/sparkle
  rm build/sparkle.tar.xz
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
if [ ! -f AppIcon.icns ]; then  # drawn once by icon.swift, then committed
  rm -rf build/AppIcon.iconset
  xcrun swiftc -O -o build/icon icon.swift
  build/icon build/AppIcon.iconset
  iconutil -c icns -o AppIcon.icns build/AppIcon.iconset
fi
cp Info.plist "$APP/Contents/"
[ -n "${VERSION:-}" ] && plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
[ -n "${BUILD:-}" ] && plutil -replace CFBundleVersion -string "$BUILD" "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/"
ditto build/sparkle/Sparkle.framework "$APP/Contents/Frameworks/Sparkle.framework"
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" -F build/sparkle -framework Sparkle \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  -o "$APP/Contents/MacOS/Eli" main.swift menu.swift notch.swift widget.swift

RES="$APP/Contents/Resources"
if [ "${BUNDLE:-}" = 1 ]; then
  ./ffmpeg.sh
  mkdir -p "$RES/bin" "$RES/licenses"
  cp build/ffmpeg/bin/ffmpeg build/ffmpeg/bin/ffprobe "$RES/bin/"
  cp build/ffmpeg/COPYING.LGPLv2.1 "$RES/licenses/ffmpeg-LGPL-2.1.txt"
  PY="$(uv python find --managed-python "$PYTHON" 2>/dev/null || { uv python install "$PYTHON" >&2 && uv python find --managed-python "$PYTHON"; })"
  ditto "$(dirname "$(dirname "$PY")")" "$RES/python"
  PYLIB="$RES/python/lib/python$PYTHON"
  rm -rf "$RES/python/include" "$RES/python/share" "$RES/python/lib/"{tcl,tk,itcl,thread}* "$RES/python/lib/lib"{tcl,tk}* \
         "$PYLIB/"{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3,config-*} "$PYLIB/lib-dynload/_tkinter"*
  (cd "$REPO" && uv export --frozen --no-dev --no-hashes --no-emit-project --quiet) > build/requirements.txt
  uv pip install --quiet --no-cache --python "$RES/python/bin/python$PYTHON" --break-system-packages -r build/requirements.txt
  # Eli's voices are French and English: piper's Hebrew and Arabic models and the other espeak dictionaries go (~45 MB)
  SITE="$PYLIB/site-packages"
  rm -rf "$SITE"/pip "$SITE"/pip-* "$SITE/piper/hebrew/nakdimon.onnx" "$SITE/piper/tashkeel/model.onnx"
  find "$SITE/piper/espeak-ng-data" -maxdepth 1 -name '*_dict' ! -name fr_dict ! -name en_dict -delete
  rsync -a --exclude __pycache__ --exclude 'test_*.py' --exclude tests "$REPO/server" "$REPO/web" "$RES/"
  cp "$REPO/LICENSE" "$RES/licenses/eli-LICENSE.txt"
  # compiled once here, checked by hash rather than date: Python never writes into the signed app
  "$RES/python/bin/python$PYTHON" -m compileall -q -j0 --invalidation-mode unchecked-hash "$RES/python/lib" "$RES/server" >/dev/null
fi

SIGN_ID="${SIGN_ID:-$(security find-identity -v -p codesigning | sed -n "s/.*\([0-9A-F]\{40\}\) \"Developer ID Application: .*($TEAM)\".*/\1/p" | head -1)}"
if [ -z "$SIGN_ID" ]; then echo "No Developer ID Application certificate for team $TEAM: signing ad hoc." >&2; SIGN_ID=-; fi
STAMP=--timestamp=none
[ "${BUNDLE:-}" = 1 ] && [ "$SIGN_ID" != - ] && STAMP=--timestamp  # notarization wants Apple's secure timestamp
sign() { codesign --force --options runtime "$STAMP" --sign "$SIGN_ID" "$@" 2>&1 | { grep -v "replacing existing signature" >&2 || true; }; }

# deepest first: everything inside, then the app whose seal covers it
if [ "${BUNDLE:-}" = 1 ]; then
  find "$RES" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 |
    while IFS= read -r -d "" f; do if file -b "$f" | grep -q Mach-O; then echo "$f"; fi; done > build/macho.txt
  echo "Signing $(wc -l < build/macho.txt | tr -d ' ') binaries in Resources…"
  tr "\n" "\0" < build/macho.txt | xargs -0 -n 40 -P 4 codesign --force --options runtime "$STAMP" --sign "$SIGN_ID" 2>&1 | { grep -v "replacing existing signature" >&2 || true; }
fi
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
for helper in "$SPARKLE"/XPCServices/*.xpc "$SPARKLE/Updater.app" "$SPARKLE/Autoupdate"; do
  sign --preserve-metadata=entitlements "$helper"
done
sign "$SPARKLE"
sign --entitlements Eli.entitlements "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $(pwd)/$APP ($(du -sh "$APP" | cut -f1))"

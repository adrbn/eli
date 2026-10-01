#!/usr/bin/env bash
# Builds build/Eli.app (Release) with swiftc and signs it with your Developer ID (hardened runtime).
# TEAM=XXXXXXXXXX ./build.sh for another team; SIGN_ID=- for an ad-hoc signature (the mic permission may not stick).
set -euo pipefail
cd "$(dirname "$0")"
TEAM="${TEAM:-2TWQF4T93E}"
APP=build/Eli.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ ! -f AppIcon.icns ]; then  # drawn once by icon.swift, then committed
  rm -rf build/AppIcon.iconset
  xcrun swiftc -O -o build/icon icon.swift
  build/icon build/AppIcon.iconset
  iconutil -c icns -o AppIcon.icns build/AppIcon.iconset
fi
cp Info.plist "$APP/Contents/"
cp AppIcon.icns "$APP/Contents/Resources/"
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" -o "$APP/Contents/MacOS/Eli" main.swift menu.swift notch.swift widget.swift
SIGN_ID="${SIGN_ID:-$(security find-identity -v -p codesigning | sed -n "s/.*\([0-9A-F]\{40\}\) \"Developer ID Application: .*($TEAM)\".*/\1/p" | head -1)}"
if [ -z "$SIGN_ID" ]; then echo "No Developer ID Application certificate for team $TEAM: signing ad hoc." >&2; SIGN_ID=-; fi
codesign --force --options runtime --timestamp=none --entitlements Eli.entitlements --sign "$SIGN_ID" "$APP"
codesign --verify --strict "$APP"
echo "Built $(pwd)/$APP"

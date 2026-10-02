#!/usr/bin/env bash
# Cuts an Eli release from this Mac: build, notarize, staple, DMG, Sparkle archive and appcast in build/release/.
#   ./release.sh 0.1.0             everything, then asks before tagging and publishing on GitHub
#   ./release.sh 0.1.0 --dry-run   (or SKIP_NOTARIZE=1) no notarization, no publishing, git checks only warn
# Release notes: notes/<version>.md if it exists, else commit subjects since the previous tag.
# Needs: the Developer ID certificate, the notarytool profile "haze" (NOTARY_PROFILE=… for another),
# the Sparkle EdDSA key in the login keychain (account "eli"), and gh logged in.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:-}"
DRY="${SKIP_NOTARIZE:-}"; [ "${2:-}" = --dry-run ] && DRY=1
TEAM="${TEAM:-2TWQF4T93E}"
NOTARY_PROFILE="${NOTARY_PROFILE:-haze}"
TAG="v$VERSION"
OUT="$(pwd)/build/release"
TMP="$OUT/tmp"
APP=build/Eli.app
ZIP="$OUT/Eli-$VERSION.zip"
DMG="$OUT/Eli-$VERSION.dmg"
SPARKLE_BIN=build/sparkle/bin

die() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
# a git check: fatal for a real release, a warning in a dry run
need() { if [ -n "$DRY" ]; then echo "  (dry run, ignored) $1"; else die "$1"; fi; }
# `cmd | grep -q` under pipefail can fail on SIGPIPE when it matched: capture first, match after
contains() { case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Usage: ./release.sh 0.1.0 [--dry-run]"
rm -rf "$TMP"; mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT  # the disk is tight: never leave scratch zips behind

# ---------------------------------------------------------------- preflight
step "Preflight"
[ -z "$(git status --porcelain)" ] || need "Working tree is dirty: commit or stash first."
[ "$(git branch --show-current)" = main ] || need "Release from main (on $(git branch --show-current))."
git fetch --quiet origin main --tags || need "Could not fetch origin."
git merge-base --is-ancestor origin/main HEAD || need "origin/main has commits this branch lacks: pull first."
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || need "Tag $TAG already exists locally."
[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || need "Tag $TAG already exists on origin."

IDENTITIES="$(security find-identity -v -p codesigning || true)"
SIGN_ID="$(printf '%s\n' "$IDENTITIES" | sed -n "s/.*\([0-9A-F]\{40\}\) \"Developer ID Application: .*($TEAM)\".*/\1/p" | head -1)"
[ -n "$SIGN_ID" ] || die "No Developer ID Application certificate for team $TEAM in the keychain."

if [ -z "$DRY" ]; then
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
    || die "Notary profile '$NOTARY_PROFILE' missing or rejected (xcrun notarytool store-credentials $NOTARY_PROFILE …)."
  gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)."
fi

# only after build.sh has fetched Sparkle once; prints the PUBLIC key, the private one never leaves the keychain
if [ -x "$SPARKLE_BIN/generate_keys" ]; then
  PUB="$("$SPARKLE_BIN/generate_keys" --account eli -p 2>/dev/null || true)"
  [ "$PUB" = "$(plutil -extract SUPublicEDKey raw Info.plist)" ] \
    || die "The keychain's Sparkle key (account eli) does not match SUPublicEDKey: installed copies would reject the update."
fi

FREE_KB="$(df -k . | awk 'NR==2 {print $4}')"
[ "$FREE_KB" -ge 1500000 ] || echo "  ⚠ only $((FREE_KB / 1024)) MB free: the app, two zips and a DMG take ~600 MB."

BUILD="$(git rev-list --count HEAD)"
echo "  $TAG: version $VERSION, build $BUILD, team $TEAM${DRY:+ (dry run)}"

# ---------------------------------------------------------------- build
step "Building"
BUNDLE=1 VERSION="$VERSION" BUILD="$BUILD" ./build.sh
SIGN_INFO="$(codesign -dv --verbose=2 "$APP" 2>&1 || true)"
contains "Authority=Developer ID Application" "$SIGN_INFO" || die "Not Developer ID-signed: an ad-hoc app can never auto-update."
ENTITLEMENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || true)"
! contains get-task-allow "$ENTITLEMENTS" || die "The app requests get-task-allow: Apple rejects that."

# `notarytool submit --wait` exits 0 on any answer, "Invalid" included: read the verdict
notarize() {
  local out id
  out="$(xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 || true)"
  printf '%s\n' "$out"
  contains "status: Accepted" "$out" && return
  id="$(printf '%s\n' "$out" | sed -n 's/^ *id: \([0-9a-f-]*\)$/\1/p' | head -1)"
  [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" 2>&1 || true
  die "Notarization of $(basename "$1") failed: nothing was published."
}

# ---------------------------------------------------------------- app
mkdir -p "$OUT"; rm -f "$ZIP" "$DMG" "$OUT/appcast.xml"
if [ -z "$DRY" ]; then
  step "Notarizing the app (usually 1-5 min)"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$TMP/Eli.zip"
  notarize "$TMP/Eli.zip"
  rm -f "$TMP/Eli.zip"
  xcrun stapler staple "$APP" || die "Stapling the app failed."
  GK="$(spctl --assess --type execute -vv "$APP" 2>&1 || true)"  # spctl's verdict, not its status
  contains accepted "$GK" || die "Gatekeeper rejects the app: $GK"
fi

step "Packaging"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"  # the Sparkle archive, with the ticket stapled in
mkdir -p "$TMP/dmg"
cp -cR "$APP" "$TMP/dmg/"  # an APFS clone: no extra space
ln -s /Applications "$TMP/dmg/Applications"
hdiutil create -quiet -volname Eli -srcfolder "$TMP/dmg" -ov -format UDZO "$DMG"
rm -rf "$TMP/dmg"
codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
if [ -z "$DRY" ]; then
  step "Notarizing the DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG" || die "Stapling the DMG failed."
  GK="$(spctl --assess --type open --context context:primary-signature -vv "$DMG" 2>&1 || true)"
  contains accepted "$GK" || die "Gatekeeper rejects the DMG: $GK"
fi

# ---------------------------------------------------------------- appcast
step "Appcast"
NOTES="$OUT/notes-$VERSION.md"
if [ -f "notes/$VERSION.md" ]; then
  cp "notes/$VERSION.md" "$NOTES"
else
  PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  git log --no-merges --pretty='- %s' ${PREV:+"$PREV"..}HEAD > "$NOTES"
fi
python3 make_appcast.py --sign-update "$SPARKLE_BIN/sign_update" --account eli \
  --zip "$ZIP" --short "$VERSION" --build "$BUILD" \
  --url "https://github.com/adrbn/eli/releases/download/$TAG/Eli-$VERSION.zip" \
  --notes-file "$NOTES" --out "$OUT/appcast.xml"

# ---------------------------------------------------------------- publish
step "Artifacts in $OUT"
for f in "$DMG" "$ZIP" "$OUT/appcast.xml" "$NOTES"; do
  printf '  %-22s %6s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
done
PUBLISH="git tag $TAG
git push origin main $TAG
gh release create $TAG $(printf '%q ' "$DMG" "$ZIP" "$OUT/appcast.xml")--title 'Eli $VERSION' --notes-file $(printf '%q' "$NOTES")"
if [ -n "$DRY" ]; then echo; echo "Dry run: not notarized, nothing published."; exit 0; fi

read -r -p "Publish $TAG on GitHub? [y/N] " reply || reply=
if [ "$reply" != y ] && [ "$reply" != Y ]; then
  printf '\nNot published. Artifacts stay in %s; to publish later, from the repo:\n%s\n' "$OUT" "$PUBLISH"
  exit 0
fi
bash -euo pipefail -c "$PUBLISH"
printf '\n\033[32m✓ Released %s\033[0m  https://github.com/adrbn/eli/releases/tag/%s\n' "$TAG" "$TAG"

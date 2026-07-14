#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/app-conductor"
IOS_DIR="$APP_DIR/ios"
OUTPUT_DIR="${OUTPUT_DIR:-$APP_DIR/build}"
WORK_DIR="$OUTPUT_DIR/.unsigned-ipa-work"
DERIVED_DATA="$WORK_DIR/DerivedData"
STAGING_DIR="$WORK_DIR/package"
BUILD_LOG="$OUTPUT_DIR/unsigned-ipa-build.log"
MIN_FREE_KB=$((3 * 1024 * 1024))

for command in node npm npx pod xcodebuild xcrun git ditto zip unzip tee; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: falta '$command' al PATH." >&2
    exit 2
  fi
done

mkdir -p "$OUTPUT_DIR"

free_kb="$(df -Pk "$APP_DIR" | awk 'NR == 2 { print $4 }')"
if [[ -z "$free_kb" || "$free_kb" -lt "$MIN_FREE_KB" ]]; then
  echo "Error: calen com a mínim 3 GiB lliures per compilar l'IPA." >&2
  echo "Espai disponible: $(( ${free_kb:-0} / 1024 )) MiB." >&2
  echo "Pots esborrar DerivedData de Xcode i tornar-ho a provar." >&2
  exit 3
fi

cleanup() {
  if [[ "${KEEP_IPA_BUILD_DATA:-0}" != "1" && -d "$WORK_DIR" ]]; then
    find "$WORK_DIR" -mindepth 1 -delete
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "→ Instal·lant dependències JavaScript"
  (cd "$APP_DIR" && npm ci --legacy-peer-deps)
fi

echo "→ Generant el projecte natiu iOS"
(cd "$APP_DIR" && npx expo prebuild --platform ios --no-install)

echo "→ Instal·lant dependències CocoaPods"
(cd "$IOS_DIR" && pod install)

echo "→ Validant TypeScript"
(cd "$APP_DIR" && npx tsc --noEmit)

mkdir -p "$DERIVED_DATA" "$STAGING_DIR/Payload"
: > "$BUILD_LOG"

echo "→ Compilant per a iPhone físic (Release, sense signatura)"
set +e
xcodebuild \
  -workspace "$IOS_DIR/appconductor.xcworkspace" \
  -scheme appconductor \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY='' \
  build 2>&1 | tee "$BUILD_LOG"
build_status="${PIPESTATUS[0]}"
set -e

if [[ "$build_status" -ne 0 ]]; then
  echo "Error: Xcode no ha pogut compilar l'app. Log: $BUILD_LOG" >&2
  exit "$build_status"
fi

APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/appconductor.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: no s'ha trobat l'app compilada a $APP_PATH" >&2
  exit 4
fi

version="$(node -p "require('$APP_DIR/app.json').expo.version")"
if git -C "$ROOT" diff --quiet --ignore-submodules -- && \
   git -C "$ROOT" diff --cached --quiet --ignore-submodules -- && \
   [[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]]; then
  revision="$(git -C "$ROOT" rev-parse --short HEAD)"
else
  revision="working-tree"
fi
output="$OUTPUT_DIR/AlVolant-unsigned-${version}-${revision}.ipa"

ditto "$APP_PATH" "$STAGING_DIR/Payload/AlVolant.app"
(
  cd "$STAGING_DIR"
  COPYFILE_DISABLE=1 zip -qry "$output" Payload
)

if ! unzip -tq "$output" >/dev/null; then
  echo "Error: l'IPA generada no és un ZIP vàlid." >&2
  exit 5
fi

echo
echo "✓ IPA unsigned creada: $output"
echo "  Nota: cal signar-la amb un certificat i provisioning profile per instal·lar-la en un iPhone."

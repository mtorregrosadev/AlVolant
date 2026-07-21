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
IOS_BUILD_LOCK="$APP_DIR/build/.ios-native-build.lock"

for command in node npm npx pod xcodebuild xcrun git ditto zip unzip tee; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: falta '$command' al PATH." >&2
    exit 2
  fi
done

mkdir -p "$OUTPUT_DIR"

acquire_ios_build_lock() {
  mkdir -p "$(dirname "$IOS_BUILD_LOCK")"
  if mkdir "$IOS_BUILD_LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$IOS_BUILD_LOCK/pid"
    return
  fi

  local owner_pid=''
  if [[ -f "$IOS_BUILD_LOCK/pid" ]]; then
    owner_pid="$(<"$IOS_BUILD_LOCK/pid")"
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    echo "Error: another iOS native build is still running (PID $owner_pid). Wait for it to finish, then try again." >&2
  else
    echo "Error: the iOS native build lock is stale at $IOS_BUILD_LOCK. Remove that directory after confirming that no Xcode build is running." >&2
  fi
  exit 6
}

release_ios_build_lock() {
  rm -f "$IOS_BUILD_LOCK/pid"
  rmdir "$IOS_BUILD_LOCK" 2>/dev/null || true
}

acquire_ios_build_lock

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
  release_ios_build_lock
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

# Expo names the generated Xcode workspace and app target after the current
# app name.  Do not retain a stale pre-rebrand target name here: this script
# should keep working when the app is renamed and prebuild recreates ios/.
workspaces=("$IOS_DIR"/*.xcworkspace)
if [[ "${#workspaces[@]}" -ne 1 || ! -d "${workspaces[0]}" ]]; then
  echo "Error: s'esperava un únic .xcworkspace a $IOS_DIR després de pod install." >&2
  exit 4
fi
WORKSPACE_PATH="${workspaces[0]}"
XCODE_SCHEME="${XCODE_SCHEME:-$(basename "$WORKSPACE_PATH" .xcworkspace)}"

mkdir -p "$DERIVED_DATA" "$STAGING_DIR/Payload"
: > "$BUILD_LOG"

echo "→ Compilant per a iPhone físic (Release, sense signatura)"
set +e
xcodebuild \
  -workspace "$WORKSPACE_PATH" \
  -scheme "$XCODE_SCHEME" \
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

APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/$XCODE_SCHEME.app"
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

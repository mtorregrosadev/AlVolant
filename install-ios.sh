#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT/app-conductor"
IOS_DIR="$APP_DIR/ios"
OUTPUT_DIR="${OUTPUT_DIR:-$APP_DIR/build}"
DERIVED_DATA="$OUTPUT_DIR/simulator-derived-data"
BUILD_LOG="$OUTPUT_DIR/install-ios.log"
MIN_FREE_KB=$((3 * 1024 * 1024))
IOS_BUILD_LOCK="$APP_DIR/build/.ios-native-build.lock"

usage() {
  cat <<'EOF'
Ús:
  ./install-ios.sh          Compila Release, instal·la i obre l'app en un iPhone Simulator.
  ./install-ios.sh --ipa    Genera una IPA unsigned per a iPhone físic.
  ./install-ios.sh --help   Mostra aquesta ajuda.

Variables opcionals:
  IOS_SIMULATOR_UDID        Força un simulador concret (ha de ser un iPhone).
  KEEP_IOS_BUILD_DATA=1     Conserva DerivedData després d'instal·lar.
  OUTPUT_DIR=/ruta          Canvia la carpeta d'artefactes (per defecte app-conductor/build).
EOF
}

case "${1:-}" in
  --ipa)
    exec "$ROOT/scripts/build_unsigned_ipa.sh"
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Error: opció desconeguda '$1'." >&2
    usage >&2
    exit 2
    ;;
esac

for command in node npm npx pod xcodebuild xcrun python3 tee plutil; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: falta '$command' al PATH." >&2
    exit 2
  fi
done

mkdir -p "$OUTPUT_DIR"

# This script only produces an iPhone Simulator build. Its API layer keeps the
# exception itself restricted to an explicit loopback HTTP origin, so the
# default does not permit arbitrary clear-text remote traffic.
export EXPO_PUBLIC_ALLOW_INSECURE_LOOPBACK="${EXPO_PUBLIC_ALLOW_INSECURE_LOOPBACK:-1}"

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
  echo "Error: calen com a mínim 3 GiB lliures per compilar iOS." >&2
  echo "Espai disponible: $(( ${free_kb:-0} / 1024 )) MiB." >&2
  echo "Pots eliminar DerivedData de Xcode i tornar-ho a provar." >&2
  exit 3
fi

if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "→ Instal·lant dependències JavaScript"
  (cd "$APP_DIR" && npm ci --legacy-peer-deps)
fi

echo "→ Generant el projecte natiu iOS"
(cd "$APP_DIR" && npx expo prebuild --platform ios --no-install)

# The portable runner serves its map only on the Simulator's loopback host.
# Keep ATS strict for remote hosts while requiring Expo prebuild to retain this
# narrow local-networking exception in the generated native project.
info_plist="$IOS_DIR/AlVolant/Info.plist"
local_networking="$(plutil -extract NSAppTransportSecurity.NSAllowsLocalNetworking raw -o - "$info_plist" 2>/dev/null || true)"
if [[ "$local_networking" != "true" ]]; then
  echo "Error: Expo prebuild did not enable NSAllowsLocalNetworking for the local map gateway." >&2
  exit 2
fi

echo "→ Instal·lant dependències CocoaPods"
(cd "$IOS_DIR" && pod install)

# Do not let a partially generated Pods directory reach xcodebuild. This can
# happen when a previous prebuild or pod install was interrupted; the native
# project then refers to a script that does not exist and Xcode reports an
# opaque PhaseScriptExecution failure.
pods_support_script="$IOS_DIR/Pods/Target Support Files/ReactNativeDependencies/ReactNativeDependencies-xcframeworks.sh"
if [[ ! -f "$IOS_DIR/Podfile.lock" || ! -f "$IOS_DIR/AlVolant.xcworkspace/contents.xcworkspacedata" || ! -f "$pods_support_script" ]]; then
  echo "Error: CocoaPods did not finish generating the iOS workspace." >&2
  echo "Run ./install-ios.sh again after closing other Expo, Xcode, or CocoaPods processes." >&2
  exit 2
fi

echo "→ Validant TypeScript"
(cd "$APP_DIR" && npx tsc --noEmit)

simulator_udid="${IOS_SIMULATOR_UDID:-}"
if [[ -z "$simulator_udid" ]]; then
  simulator_udid="$({ xcrun simctl list devices booted --json || true; } | python3 -c '
import json, sys
try:
    runtimes = json.load(sys.stdin).get("devices", {})
except json.JSONDecodeError:
    raise SystemExit(0)
for devices in runtimes.values():
    for device in devices:
        if device.get("state") == "Booted" and device.get("isAvailable", True) and device.get("name", "").startswith("iPhone"):
            print(device["udid"])
            raise SystemExit(0)
')"
fi

if [[ -z "$simulator_udid" ]]; then
  simulator_udid="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
runtimes = json.load(sys.stdin).get("devices", {})
candidates = [
    device
    for devices in runtimes.values()
    for device in devices
    if device.get("isAvailable", True) and device.get("name", "").startswith("iPhone")
]
preferred = next((device for device in candidates if device.get("name") == "iPhone 17 Pro"), None)
chosen = preferred or (candidates[0] if candidates else None)
if chosen:
    print(chosen["udid"])
')"
  if [[ -z "$simulator_udid" ]]; then
    echo "Error: no hi ha cap iPhone Simulator disponible." >&2
    exit 4
  fi
  echo "→ Arrencant l'iPhone Simulator $simulator_udid"
  xcrun simctl boot "$simulator_udid" 2>/dev/null || true
  xcrun simctl bootstatus "$simulator_udid" -b
fi

simulator_name="$(xcrun simctl list devices --json | python3 -c '
import json, sys
target = sys.argv[1]
for devices in json.load(sys.stdin).get("devices", {}).values():
    for device in devices:
        if device.get("udid") == target:
            print(device.get("name", ""))
            raise SystemExit(0)
' "$simulator_udid")"
if [[ "$simulator_name" != iPhone* ]]; then
  echo "Error: '$simulator_name' no és un iPhone Simulator. No es provarà en iPad." >&2
  exit 4
fi

rm -rf "$DERIVED_DATA"
mkdir -p "$DERIVED_DATA"
: > "$BUILD_LOG"

cleanup() {
  if [[ "${KEEP_IOS_BUILD_DATA:-0}" != "1" ]]; then
    rm -rf "$DERIVED_DATA"
  fi
  release_ios_build_lock
}
trap cleanup EXIT

echo "→ Compilant Release per a $simulator_name"
simulator_arch="$(uname -m)"
set +e
xcodebuild \
  -workspace "$IOS_DIR/AlVolant.xcworkspace" \
  -scheme AlVolant \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -derivedDataPath "$DERIVED_DATA" \
  ARCHS="$simulator_arch" \
  ONLY_ACTIVE_ARCH=YES \
  build 2>&1 | tee "$BUILD_LOG"
build_status="${PIPESTATUS[0]}"
set -e

if [[ "$build_status" -ne 0 ]]; then
  echo "Error: Xcode no ha pogut compilar l'app. Log: $BUILD_LOG" >&2
  exit "$build_status"
fi

app_path="$DERIVED_DATA/Build/Products/Release-iphonesimulator/AlVolant.app"
if [[ ! -d "$app_path" ]]; then
  echo "Error: no s'ha trobat l'app compilada a $app_path" >&2
  exit 5
fi

echo "→ Instal·lant en $simulator_name"
xcrun simctl install "$simulator_udid" "$app_path"
xcrun simctl launch --terminate-running-process "$simulator_udid" com.mtorregrosadev.AlVolant >/dev/null

echo
echo "✓ AlVolant compilada, instal·lada i oberta a $simulator_name."
echo "  Log: $BUILD_LOG"
echo "  IPA unsigned: ./install-ios.sh --ipa"

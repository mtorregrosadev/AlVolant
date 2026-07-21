#!/usr/bin/env bash
set -euo pipefail

# One-command local demo for judges and contributors. It keeps the BFF on
# loopback, creates only missing local configuration files, and never prints
# their values.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"
FALLBACK_ENV_FILE="$ROOT/.env.run-local"
APP_ENV_FILE="$ROOT/app-conductor/.env.local"
READY_URL="http://127.0.0.1:8000/health/ready"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-600}"
LOCAL_MAP_PORT="${LOCAL_MAP_PORT:-3002}"
LOCAL_MAP_ORIGIN="http://localhost:${LOCAL_MAP_PORT}"
LOCAL_MAP_DATA_DIR="${LOCAL_MAP_DATA_DIR:-$ROOT/.alvolant/maps}"
LOCAL_MAP_TILES_DIR="$LOCAL_MAP_DATA_DIR/tiles"
LOCAL_MAP_INPUT_DIR="$LOCAL_MAP_DATA_DIR/input"
LOCAL_MAP_STYLES_DIR="$LOCAL_MAP_DATA_DIR/styles"
LOCAL_MAP_TILE_FILE="$LOCAL_MAP_TILES_DIR/catalunya.pmtiles"
LOCAL_MAP_READY_URL="$LOCAL_MAP_ORIGIN/health"
LOCAL_MAP_TILEJSON_URL="$LOCAL_MAP_ORIGIN/maps/tiles/catalunya"
LOCAL_MAP_BOOTSTRAP_MODE="${ALVOLANT_BOOTSTRAP_MAPS:-ask}"
LOCAL_MAP_JAVA_HEAP="${LOCAL_MAP_JAVA_HEAP:-2g}"
LOCAL_MAP_MIN_FREE_KB=$((8 * 1024 * 1024))
LOCAL_MAP_SOURCE_URL="https://download.geofabrik.de/europe/spain/cataluna-latest.osm.pbf"
PLANETILER_IMAGE="ghcr.io/onthegomap/planetiler:0.8.0@sha256:01a5acecc166a9e607cdc3cd08f1875115355b6d5e5dfe442ab1735d20012f0e"
RUN_IOS=1
ACTION='up'
REBUILD_LOCAL_MAP=0
COMPOSE_ENVIRONMENT=""
COMPOSE_ENV_FILE=""
COMPOSE_BFF_KEY=""
COMPOSE_RATE_LIMIT_HASH_KEY=""
COMPOSE_REDIS_PASSWORD=""
COMPOSE_TOMTOM_API_KEY=""
COMPOSE_ARCGIS_API_KEY=""
COMPOSE_TMB_APP_ID=""
COMPOSE_TMB_APP_KEY=""

usage() {
  cat <<'EOF'
Usage:
  ./run-local.sh           Bootstrap the local vector map, start the full stack, then build and open AlVolant on an iPhone Simulator.
  ./run-local.sh --no-ios  Bootstrap the local vector map and start the full stack without iOS.
  ./run-local.sh --rebuild-map  Rebuild the cached local vector map from public OSM data, then start the full stack.
  ./run-local.sh --down    Stop the local Docker stack.
  ./run-local.sh --help    Show this help.

Environment:
  READY_TIMEOUT_SECONDS    Maximum time to wait for /health/ready (default: 600).
  IOS_SIMULATOR_UDID       Optional iPhone Simulator selected by install-ios.sh.
  ALVOLANT_BOOTSTRAP_MAPS  Use 1 to accept the initial local map bootstrap without a prompt.
  LOCAL_MAP_DATA_DIR       Ignored cache directory for OSM input and PMTiles output.
  LOCAL_MAP_JAVA_HEAP      Heap passed to Planetiler while it generates the archive (default: 2g).

The script creates .env and app-conductor/.env.local only when they do not
exist. If an existing .env cannot run Docker, it creates .env.run-local and
leaves the existing file unchanged. The first map bootstrap downloads public
OpenStreetMap and Planetiler source data, needs at least 8 GiB free disk space,
at least 4 GiB assigned to Docker Desktop, and can take several minutes. It
never uses an AlVolant DNS name.
EOF
}

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

read_env_value() {
  local file="$1"
  local key="$2"
  local value

  value="$(awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
    }
    END {
      printf "%s", value
    }
  ' "$file")"
  value="${value%$'\r'}"

  if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s' "$value"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 64 | tr '+/' '_-' | tr -d '=\n' | cut -c1-48
    return
  fi

  python3 -c 'import secrets; print(secrets.token_urlsafe(48)[:48])'
}

create_backend_env() {
  local target_file="$1"
  local requested_bff_key="${2:-}"
  local bff_key rate_limit_key redis_password
  bff_key="$requested_bff_key"
  if [[ -z "$bff_key" ]]; then
    bff_key="$(generate_secret)"
  fi
  rate_limit_key="$(generate_secret)"
  redis_password="$(generate_secret)"

  log "→ Creating local Docker configuration with random development values"
  (
    umask 077
    printf '%s\n' \
      '# Created by run-local.sh. Local development only; never commit this file.' \
      'ENVIRONMENT=development' \
      "BFF_API_KEY=$bff_key" \
      "RATE_LIMIT_HASH_KEY=$rate_limit_key" \
      "REDIS_PASSWORD=$redis_password" \
      'REDIS_URL=redis://localhost:6379/0' \
      'REDIS_HOST=localhost' \
      'REDIS_PORT=6379' \
      'REDIS_DB=0' \
      'SERVER_HOST=127.0.0.1' \
      'SERVER_PORT=8000' \
      'BFF_BIND_ADDRESS=127.0.0.1' \
      'FORWARDED_ALLOW_IPS=127.0.0.1' \
      'TRUSTED_HOSTS=localhost,127.0.0.1' \
      'DOCS_ENABLED=true' \
      'LOG_LEVEL=info' \
      'TELEMETRY_ENABLED=true' \
      'TOMTOM_API_KEY=' \
      'ARCGIS_API_KEY=' \
      'TMB_APP_ID=' \
      'TMB_APP_KEY=' \
      > "$target_file"
  )
}

load_backend_env() {
  local config_file="$1"
  local environment bff_key rate_limit_key redis_password
  [[ -f "$config_file" ]] || return 1
  environment="$(read_env_value "$config_file" 'ENVIRONMENT')"
  bff_key="$(read_env_value "$config_file" 'BFF_API_KEY')"
  rate_limit_key="$(read_env_value "$config_file" 'RATE_LIMIT_HASH_KEY')"
  redis_password="$(read_env_value "$config_file" 'REDIS_PASSWORD')"

  if [[ -z "$environment" ]]; then
    environment='development'
  fi

  [[ "$environment" == 'development' || "$environment" == 'production' ]] || return 1
  [[ ${#bff_key} -ge 32 && ${#bff_key} -le 512 ]] || return 1
  [[ ${#rate_limit_key} -ge 32 && ${#rate_limit_key} -le 512 ]] || return 1
  [[ ${#redis_password} -ge 32 && ${#redis_password} -le 512 && "$redis_password" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  COMPOSE_ENVIRONMENT="$environment"
  COMPOSE_ENV_FILE="$config_file"
  COMPOSE_BFF_KEY="$bff_key"
  COMPOSE_RATE_LIMIT_HASH_KEY="$rate_limit_key"
  COMPOSE_REDIS_PASSWORD="$redis_password"
  COMPOSE_TOMTOM_API_KEY="$(read_env_value "$config_file" 'TOMTOM_API_KEY')"
  COMPOSE_ARCGIS_API_KEY="$(read_env_value "$config_file" 'ARCGIS_API_KEY')"
  COMPOSE_TMB_APP_ID="$(read_env_value "$config_file" 'TMB_APP_ID')"
  COMPOSE_TMB_APP_KEY="$(read_env_value "$config_file" 'TMB_APP_KEY')"
}

create_app_env() {
  local bff_key="$1"

  log "→ Creating app-conductor/.env.local with the matching local BFF key"
  (
    umask 077
    printf '%s\n' \
      '# Created by run-local.sh. Expo includes this development key in a local build.' \
      "EXPO_PUBLIC_BFF_API_KEY=$bff_key" \
      'EXPO_PUBLIC_BFF_URL=http://localhost:8000' \
      "EXPO_PUBLIC_MAP_ORIGIN=$LOCAL_MAP_ORIGIN" \
      'EXPO_PUBLIC_ALLOW_INSECURE_LOOPBACK=1' \
      > "$APP_ENV_FILE"
  )
}

ensure_local_configuration() {
  if [[ ! -e "$ENV_FILE" ]]; then
    create_backend_env "$ENV_FILE"
  elif [[ ! -f "$ENV_FILE" ]]; then
    fail "$ENV_FILE exists but is not a regular file."
  fi

  if ! load_backend_env "$ENV_FILE"; then
    if [[ ! -e "$FALLBACK_ENV_FILE" ]]; then
      log "• Existing .env cannot start the Docker stack. Leaving it unchanged."
      create_backend_env "$FALLBACK_ENV_FILE"
    elif [[ ! -f "$FALLBACK_ENV_FILE" ]]; then
      fail "$FALLBACK_ENV_FILE exists but is not a regular file."
    fi

    load_backend_env "$FALLBACK_ENV_FILE" || fail "The local Docker configuration is invalid. Remove .env.run-local and run the script again."
  fi

  if [[ ! -e "$APP_ENV_FILE" ]]; then
    create_app_env "$COMPOSE_BFF_KEY"
  elif [[ ! -f "$APP_ENV_FILE" ]]; then
    fail "$APP_ENV_FILE exists but is not a regular file."
  fi
}

compose() {
  (
    cd "$ROOT"
    BFF_BIND_ADDRESS=127.0.0.1 \
      ENVIRONMENT="$COMPOSE_ENVIRONMENT" \
      BFF_API_KEY="$COMPOSE_BFF_KEY" \
      RATE_LIMIT_HASH_KEY="$COMPOSE_RATE_LIMIT_HASH_KEY" \
      REDIS_PASSWORD="$COMPOSE_REDIS_PASSWORD" \
      TOMTOM_API_KEY="$COMPOSE_TOMTOM_API_KEY" \
      ARCGIS_API_KEY="$COMPOSE_ARCGIS_API_KEY" \
      TMB_APP_ID="$COMPOSE_TMB_APP_ID" \
      TMB_APP_KEY="$COMPOSE_TMB_APP_KEY" \
      LOCAL_MAP_DATA_DIR="$LOCAL_MAP_DATA_DIR" \
      LOCAL_MAP_PORT="$LOCAL_MAP_PORT" \
      docker compose --env-file "$COMPOSE_ENV_FILE" "$@"
  )
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker Desktop is required. Install it, start it, and run this script again."
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

  if docker info >/dev/null 2>&1; then
    return
  fi

  if [[ "$(uname -s)" == 'Darwin' ]] && command -v open >/dev/null 2>&1; then
    log "→ Opening Docker Desktop"
    open -a Docker >/dev/null 2>&1 || true
    local deadline=$((SECONDS + 90))
    while (( SECONDS < deadline )); do
      if docker info >/dev/null 2>&1; then
        return
      fi
      sleep 2
    done
  fi

  fail "Docker Desktop is not ready. Start it and run this script again."
}

ensure_ios_host_requirements() {
  (( RUN_IOS )) || return

  [[ "$(uname -s)" == 'Darwin' ]] || fail "The iPhone Simulator build requires macOS. Use ./run-local.sh --no-ios to start only the local services."

  local required_command
  for required_command in node npm npx pod xcodebuild xcrun python3; do
    command -v "$required_command" >/dev/null 2>&1 \
      || fail "'$required_command' is required for the iPhone Simulator build. Install the macOS prerequisites, or use ./run-local.sh --no-ios."
  done

  # Fail before a large OSM download when Xcode has no usable iPhone runtime.
  # The project deliberately never falls back to an iPad runtime.
  if ! xcrun simctl list devices available --json 2>/dev/null | python3 -c '
import json
import sys

try:
    devices = json.load(sys.stdin).get("devices", {})
except (json.JSONDecodeError, BrokenPipeError):
    raise SystemExit(1)

has_iphone = any(
    device.get("isAvailable", True) and device.get("name", "").startswith("iPhone")
    for runtime_devices in devices.values()
    for device in runtime_devices
)
raise SystemExit(0 if has_iphone else 1)
'; then
    fail "No available iPhone Simulator runtime was found. Install one in Xcode, then run again."
  fi

  case "$(uname -m)" in
    arm64|x86_64)
      log "✓ iPhone host ready ($(uname -m)); the local map images support this architecture."
      ;;
    *)
      log "• Host architecture $(uname -m) is not in the tested Mac matrix. Docker may need emulation."
      ;;
  esac
}

ensure_docker_memory_for_map_build() {
  local memory_bytes
  memory_bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"

  # Docker Desktop reports its VM memory in bytes. Do not guess if an older
  # engine does not expose the field, but prevent a predictable Planetiler OOM
  # when it does.
  if [[ "$memory_bytes" =~ ^[0-9]+$ ]] && (( memory_bytes < 4294967296 )); then
    fail "Planetiler needs at least 4 GiB assigned to Docker Desktop. Increase Docker Desktop memory, then run again."
  fi
}

validate_local_map_configuration() {
  [[ "$LOCAL_MAP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || fail "LOCAL_MAP_PORT must be a valid TCP port."
  (( LOCAL_MAP_PORT <= 65535 )) || fail "LOCAL_MAP_PORT must be at most 65535."
  [[ "$LOCAL_MAP_JAVA_HEAP" =~ ^[1-9][0-9]*[mMgG]$ ]] || fail "LOCAL_MAP_JAVA_HEAP must look like 2g or 1536m."
  [[ -d "$ROOT/maps/style-templates" ]] || fail "Local map style templates are missing. Restore maps/style-templates."
  [[ -d "$ROOT/maps/assets/fonts" ]] || fail "Local map fonts are missing. Restore maps/assets/fonts."
}

has_local_map_archive() {
  [[ -f "$LOCAL_MAP_TILE_FILE" ]] && [[ "$(wc -c < "$LOCAL_MAP_TILE_FILE")" -gt 1048576 ]]
}

confirm_local_map_bootstrap() {
  case "$LOCAL_MAP_BOOTSTRAP_MODE" in
    1|yes|true)
      return
      ;;
    0|no|false)
      fail "The local vector map is required for this portable stack. Remove ALVOLANT_BOOTSTRAP_MAPS=0 and run again."
      ;;
    ask)
      if [[ ! -t 0 ]]; then
        fail "The local vector map is not cached. Run interactively or set ALVOLANT_BOOTSTRAP_MAPS=1."
      fi
      log
      log "AlVolant can now build its regular light and dark map locally."
      log "This one-time step downloads public OSM/Planetiler data, needs at least 8 GiB free disk space, and can take several minutes."
      log "No AlVolant DNS or server is used."
      local answer
      read -r -p "Build the local vector map now? [Y/n] " answer
      case "${answer:-Y}" in
        Y|y|yes|YES)
          return
          ;;
        *)
          fail "The local map was not created. Run ./run-local.sh again when you want the complete portable stack."
          ;;
      esac
      ;;
    *)
      fail "ALVOLANT_BOOTSTRAP_MAPS must be ask, 1, or 0."
      ;;
  esac
}

ensure_local_map_disk_space() {
  local available_kb
  available_kb="$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || fail "Could not determine free disk space for the local map."
  if (( available_kb < LOCAL_MAP_MIN_FREE_KB )); then
    fail "The local map bootstrap needs at least 8 GiB free. Available: $(( available_kb / 1024 )) MiB."
  fi
}

download_local_osm_extract() {
  local target_file="$LOCAL_MAP_INPUT_DIR/catalunya.osm.pbf"
  local partial_file="$target_file.partial"
  local -a resume_args=()

  if [[ -f "$target_file" ]] && [[ "$(wc -c < "$target_file")" -gt 1048576 ]]; then
    return
  fi

  mkdir -p "$LOCAL_MAP_INPUT_DIR"
  if [[ -f "$partial_file" ]]; then
    resume_args=(--continue-at -)
  fi

  log "→ Downloading the Catalunya OpenStreetMap extract from Geofabrik"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 15 \
    "${resume_args[@]}" --output "$partial_file" "$LOCAL_MAP_SOURCE_URL"
  mv "$partial_file" "$target_file"
}

render_local_map_styles() {
  mkdir -p "$LOCAL_MAP_STYLES_DIR"
  cp "$ROOT/maps/style-templates/"* "$LOCAL_MAP_STYLES_DIR/"
  perl -0pi -e "s|__MAP_ORIGIN__|$LOCAL_MAP_ORIGIN|g" \
    "$LOCAL_MAP_STYLES_DIR/dark.json" "$LOCAL_MAP_STYLES_DIR/light.json"
}

build_local_map_archive() {
  confirm_local_map_bootstrap
  ensure_local_map_disk_space
  ensure_docker_memory_for_map_build
  mkdir -p "$LOCAL_MAP_TILES_DIR" "$LOCAL_MAP_INPUT_DIR"
  download_local_osm_extract

  log "→ Building the local PMTiles archive with Planetiler"
  log "  This runs once and caches the result in ${LOCAL_MAP_DATA_DIR#$ROOT/}."
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e "JAVA_TOOL_OPTIONS=-Xmx$LOCAL_MAP_JAVA_HEAP" \
    -v "$LOCAL_MAP_DATA_DIR:/data" \
    "$PLANETILER_IMAGE" \
    --download \
    --osm-path=/data/input/catalunya.osm.pbf \
    --output=/data/tiles/catalunya.pmtiles \
    --force

  has_local_map_archive || fail "Planetiler finished without a valid Catalunya PMTiles archive."
}

ensure_local_map_assets() {
  validate_local_map_configuration

  if (( REBUILD_LOCAL_MAP )) || ! has_local_map_archive; then
    build_local_map_archive
  else
    log "✓ Using cached local vector map: ${LOCAL_MAP_TILE_FILE#$ROOT/}"
  fi

  render_local_map_styles
}

wait_for_local_map() {
  local deadline=$((SECONDS + 90))
  log "→ Waiting for the local vector map"

  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_READY_URL" >/dev/null 2>&1 \
      && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_ORIGIN/maps/styles/dark.json" >/dev/null 2>&1 \
      && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_ORIGIN/maps/styles/light.json" >/dev/null 2>&1 \
      && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_ORIGIN/maps/styles/dark-sprite.json" >/dev/null 2>&1 \
      && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_TILEJSON_URL" >/dev/null 2>&1 \
      && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_ORIGIN/maps/tiles/font/Noto%20Sans%20Regular/0-255" >/dev/null 2>&1 \
      && curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$LOCAL_MAP_ORIGIN/maps/tiles/catalunya/14/8292/6118" >/dev/null 2>&1; then
      log "✓ Local vector map is ready at $LOCAL_MAP_ORIGIN"
      return
    fi
    sleep 2
  done

  log "The local vector map did not become ready. Recent map logs follow:"
  compose logs --tail=80 maps map-gateway >&2 || true
  fail "Check Docker Desktop and the cached map archive at $LOCAL_MAP_TILE_FILE."
}

wait_for_backend() {
  [[ "$READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "READY_TIMEOUT_SECONDS must be a positive integer."

  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  local last_notice=$SECONDS
  log "→ Waiting for Redis, the BFF, and the GTFS catalogue"
  log "  The first download can take several minutes."

  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$READY_URL" >/dev/null 2>&1; then
      log "✓ BFF is ready at http://localhost:8000"
      return
    fi

    if (( SECONDS - last_notice >= 15 )); then
      log "  Still preparing data…"
      last_notice=$SECONDS
    fi
    sleep 2
  done

  log "The BFF did not become ready in ${READY_TIMEOUT_SECONDS} seconds. Recent BFF logs follow:"
  compose logs --tail=80 bff >&2 || true
  fail "Check Docker Desktop, Internet access to the public transport feeds, and the local Docker configuration."
}

open_ios_simulator() {
  if [[ "$(uname -s)" != 'Darwin' ]] || ! command -v xcrun >/dev/null 2>&1; then
    log "• iPhone Simulator is not available on this machine. The local stack is ready."
    return
  fi

  if ! xcrun simctl list devices available --json >/dev/null 2>&1; then
    log "• No iPhone Simulator runtime is installed. The local stack is ready."
    return
  fi

  if command -v open >/dev/null 2>&1; then
    log "→ Opening Simulator"
    open -a Simulator >/dev/null 2>&1 || log "• Simulator could not open yet; install-ios.sh will try to boot an iPhone."
  fi

  log "→ Building and opening AlVolant on an iPhone Simulator"
  if [[ -n "${IOS_SIMULATOR_UDID:-}" ]]; then
    EXPO_PUBLIC_BFF_API_KEY="$COMPOSE_BFF_KEY" \
      EXPO_PUBLIC_BFF_URL="http://localhost:8000" \
      EXPO_PUBLIC_MAP_ORIGIN="$LOCAL_MAP_ORIGIN" \
      EXPO_PUBLIC_ALLOW_INSECURE_LOOPBACK=1 \
      IOS_SIMULATOR_UDID="$IOS_SIMULATOR_UDID" \
      "$ROOT/install-ios.sh"
  else
    EXPO_PUBLIC_BFF_API_KEY="$COMPOSE_BFF_KEY" \
      EXPO_PUBLIC_BFF_URL="http://localhost:8000" \
      EXPO_PUBLIC_MAP_ORIGIN="$LOCAL_MAP_ORIGIN" \
      EXPO_PUBLIC_ALLOW_INSECURE_LOOPBACK=1 \
      "$ROOT/install-ios.sh"
  fi
}

case "${1:-}" in
  --no-ios)
    RUN_IOS=0
    ;;
  --rebuild-map)
    REBUILD_LOCAL_MAP=1
    ;;
  --down)
    ACTION='down'
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  '')
    ;;
  *)
    fail "Unknown option '$1'. Use --help for help."
    ;;
esac

if [[ "$ACTION" == 'down' ]]; then
  ensure_local_configuration
  ensure_docker
  compose down
  log "Local stack stopped."
  exit 0
fi

ensure_ios_host_requirements
ensure_local_configuration
ensure_docker

if (( REBUILD_LOCAL_MAP )); then
  # Avoid replacing an archive while a previous Martin process still has it
  # open. Keeping the BFF and Redis running makes this a targeted rebuild.
  log "→ Stopping the previous local map services before rebuilding the archive"
  compose stop maps map-gateway >/dev/null 2>&1 || true
fi

ensure_local_map_assets

log "→ Validating Docker Compose configuration"
compose config >/dev/null

log "→ Starting Redis, the BFF, and the local vector map on loopback"
compose up --build --detach
wait_for_local_map
wait_for_backend

if (( RUN_IOS )); then
  open_ios_simulator
fi

log
log "Done. Stop the local stack with: ./run-local.sh --down"

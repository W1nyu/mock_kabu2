#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
compose() {
  docker compose --env-file "${MOCK_KABU_ENV_FILE:-$ROOT/deploy/production/.env.production}" \
    -f deploy/production/compose.production.yml \
    -f "${MOCK_KABU_COMPOSE_OVERLAY:-deploy/gcp/compose.gcp.yml}" "$@"
}
case "${1:-status}" in
  status)
    date -Is
    uptime
    free -h
    df -h /
    compose ps
    docker stats --no-stream $(compose ps -q)
    ;;
  users)
    compose exec -T api node -e 'fetch("http://127.0.0.1:4100/internal/operations").then(async r=>{if(!r.ok)throw Error(r.status); console.log(JSON.stringify(await r.json(),null,2))}).catch(e=>{console.error(e);process.exit(1)})'
    ;;
  health)
    compose exec -T api node -e 'fetch("http://127.0.0.1:4100/health/trading").then(async r=>{console.log(JSON.stringify(await r.json(),null,2));process.exitCode=r.ok?0:1}).catch(e=>{console.error(e);process.exit(1)})'
    ;;
  traffic)
    minutes="${2:-5}"
    [[ "$minutes" =~ ^[0-9]+$ ]] && ((minutes >= 1 && minutes <= 60)) || { echo 'minutes: 1..60' >&2; exit 2; }
    compose logs --no-color --no-log-prefix --since "${minutes}m" --tail 100000 caddy | python3 scripts/ops/traffic.py "$minutes"
    ;;
  network)
    python3 scripts/ops/network.py
    ;;
  review)
    bash "$0" status
    bash "$0" users
    bash "$0" health
    bash "$0" traffic "${2:-5}"
    bash "$0" network
    ;;
  security)
    python3 scripts/ops/check-security.py "${2:-https://jobradar.my}"
    ;;
  watch)
    while true; do bash "$0" users; bash "$0" status; sleep 5; done
    ;;
  load)
    shift
    # Host networking measures the public HTTPS route. It also allows an explicit
    # loopback staging target. No secrets or production env are passed to the client.
    image="$(docker inspect "$(compose ps -q web)" --format '{{.Image}}')"
    docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
      --memory 512m --cpus 1 -v "$ROOT/scripts/ops:/ops:ro" --entrypoint node "$image" /ops/load.mjs "$@"
    ;;
  *) echo 'Usage: bash scripts/ops/ops.sh {review [minutes]|status|users|health|traffic [minutes]|network|security [URL]|watch|load URL [users=5] [seconds=30]}' >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Prepare database containers, then initialize a new exchange database.
set -euo pipefail

ROOT="${REPO_DIR:-/opt/mock-kabu2}"
ENV_FILE="$ROOT/deploy/production/.env.production"
cd "$ROOT"
[[ -s "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }

compose() {
  docker compose --env-file "$ENV_FILE" \
    -f deploy/production/compose.production.yml \
    -f deploy/gcp/compose.gcp.yml "$@"
}

case "${1:-}" in
  prepare)
    compose config --quiet
    # All application services share APP_IMAGE; build that tag only once.
    compose build postgres api
    docker builder prune -af --reserved-space 2GB
    compose up -d --wait postgres redis
    compose exec -T -u postgres postgres pgbackrest --stanza=mock-kabu stanza-create
    compose ps
    ;;
  start)
    compose run --rm migrate
    compose up -d --remove-orphans
    compose ps
    ;;
  timers)
    install -m 0644 deploy/gcp/systemd/* /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now \
      mock-kabu-backup.timer mock-kabu-prune.timer \
      mock-kabu-build-cache-prune.timer mock-kabu-storage-guard.timer \
      mock-kabu-maintenance-start.timer mock-kabu-maintenance-end.timer
    systemctl list-timers 'mock-kabu-*'
    ;;
  status)
    compose ps
    ;;
  *)
    echo 'Usage: deploy.sh prepare|start|timers|status' >&2
    exit 2
    ;;
esac

#!/bin/sh
# Shared helpers for the production operational scripts. This file is sourced;
# callers must set SCRIPT_DIR to deploy/production/scripts first.
set -eu

: "${SCRIPT_DIR:?SCRIPT_DIR must be set before sourcing lib.sh}"

DEPLOY_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${MOCK_KABU_COMPOSE_FILE:-$DEPLOY_DIR/compose.production.yml}"
ENV_FILE="${MOCK_KABU_ENV_FILE:-$DEPLOY_DIR/.env.production}"
STANZA="${PGBACKREST_STANZA:-mock-kabu}"

fail() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker with the Compose plugin is required."
  docker compose version >/dev/null 2>&1 || fail "docker compose is not available."
  [ -f "$COMPOSE_FILE" ] || fail "Compose file not found: $COMPOSE_FILE"
  [ -f "$ENV_FILE" ] || fail "Production env file not found: $ENV_FILE"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

running_postgres_id() {
  compose ps --status running -q postgres
}

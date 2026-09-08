#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_docker

# This script intentionally removes only the resolved PostgreSQL data volume.
# The encrypted pgBackRest repository volume is retained as the restore source.
if [ "${PGBACKREST_RESTORE_CONFIRM:-}" != "RESTORE_MOCK_KABU" ]; then
  fail "Refusing restore. Set PGBACKREST_RESTORE_CONFIRM=RESTORE_MOCK_KABU after selecting a backup."
fi

if [ -n "$(running_postgres_id)" ]; then
  compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" info
fi

postgres_volume="$(compose config --volumes | awk '/-postgres-data$/ { print; exit }')"
[ -n "$postgres_volume" ] || fail "Could not resolve the PostgreSQL data volume from Compose config."
case "$postgres_volume" in
  *-postgres-data) ;;
  *) fail "Refusing unexpected PostgreSQL volume name: $postgres_volume" ;;
esac

docker volume inspect "$postgres_volume" >/dev/null 2>&1 || fail "PostgreSQL data volume does not exist: $postgres_volume"

printf '%s\n' "Restoring stanza '$STANZA' into replacement volume '$postgres_volume'."
printf '%s\n' "All current database contents will be replaced; the pgBackRest repository is kept."

# Stop every writer before removing the data volume. `down` deliberately omits
# -v so Redis, Caddy certificates, and the pgBackRest repository survive.
compose down --remove-orphans
docker volume rm "$postgres_volume"

# `create` recreates the empty named volume without starting PostgreSQL. The
# official postgres entrypoint is bypassed for the one-off pgBackRest process.
compose create postgres

set -- --stanza="$STANZA"
if [ -n "${PGBACKREST_SET:-}" ]; then
  set -- "$@" "--set=$PGBACKREST_SET"
fi
set -- "$@" restore
compose run --rm --no-deps --user postgres --entrypoint pgbackrest postgres "$@"

# Migration and seed containers are recreated as part of the normal startup.
compose up -d
printf '%s\n' "Restore command completed. Wait for services, then run:"
printf '%s\n' "  docker compose --env-file '$ENV_FILE' -f '$COMPOSE_FILE' run --rm --no-deps api consistency"

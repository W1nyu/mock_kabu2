#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_docker
[ -n "$(running_postgres_id)" ] || fail "The production postgres service is not running."

compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" info
compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" check

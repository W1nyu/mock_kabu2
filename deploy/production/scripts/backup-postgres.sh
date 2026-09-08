#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

backup_type="${1:-incr}"
case "$backup_type" in
  full|diff|incr) ;;
  *)
    fail "Usage: sh backup-postgres.sh [full|diff|incr]"
    ;;
esac

require_docker
[ -n "$(running_postgres_id)" ] || fail "The production postgres service is not running."

# Re-running stanza-create is safe and lets a restored/new cluster initialize
# the repository before its first backup.
compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" stanza-create
compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" check
compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" --type="$backup_type" backup
compose exec -T -u postgres postgres pgbackrest --stanza="$STANZA" info

#!/bin/sh
# pgBackRest rejects empty optional S3 variables, even for a local repository.
if [ -z "${PGBACKREST_REPO1_S3_KEY:-}" ]; then
  unset PGBACKREST_REPO1_S3_KEY
fi
if [ -z "${PGBACKREST_REPO1_S3_KEY_SECRET:-}" ]; then
  unset PGBACKREST_REPO1_S3_KEY_SECRET
fi
# The official image creates POSTGRES_USER, which need not be named postgres.
if [ -z "${PGBACKREST_PG1_USER:-}" ] && [ -n "${POSTGRES_USER:-}" ]; then
  export PGBACKREST_PG1_USER="$POSTGRES_USER"
fi
exec /usr/bin/pgbackrest "$@"

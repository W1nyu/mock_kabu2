#!/bin/sh
set -eu

# The official postgres entrypoint runs init scripts only after its temporary
# server is available, so the initialized cluster has a valid pg_control file.
: "${PGBACKREST_REPO1_CIPHER_PASS:?PGBACKREST_REPO1_CIPHER_PASS must be set}"
pgbackrest --stanza=mock-kabu stanza-create

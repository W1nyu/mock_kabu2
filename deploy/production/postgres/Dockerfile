# The official PostgreSQL image supplies its well-tested init/entrypoint flow.
# This layer adds pgBackRest and a first-cluster stanza hook only.
FROM postgres:16-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends -y pgbackrest \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/pgbackrest \
    && chown -R postgres:postgres /var/lib/pgbackrest

COPY --chown=postgres:postgres deploy/production/postgres/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chown=postgres:postgres --chmod=755 deploy/production/postgres/10-pgbackrest-stanza.sh /docker-entrypoint-initdb.d/10-pgbackrest-stanza.sh

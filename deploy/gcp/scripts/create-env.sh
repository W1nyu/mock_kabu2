#!/usr/bin/env bash
# Create new, independent production secrets on the GCP VM. Never overwrite an existing env.
set -euo pipefail

PUBLIC_IP="${1:?Usage: create-env.sh STATIC_PUBLIC_IP}"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected an IPv4 address' >&2; exit 2; }
ROOT="${REPO_DIR:-/opt/mock-kabu2}"
ENV_FILE="$ROOT/deploy/production/.env.production"
[[ ! -e "$ENV_FILE" ]] || { echo "$ENV_FILE already exists; refusing to overwrite" >&2; exit 1; }
umask 077
secret() { openssl rand -hex 32; }
cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=mock-kabu2-prod
APP_IMAGE=mock-kabu2-app:gcp
APP_DOMAIN=localhost
APP_ORIGIN=http://$PUBLIC_IP
CADDYFILE=../gcp/Caddyfile.http
CADDY_EMAIL=admin@jobradar.my
POSTGRES_USER=mock_kabu
POSTGRES_PASSWORD=$(secret)
POSTGRES_DB=mock_kabu2
REDIS_PASSWORD=$(secret)
REDIS_MAXMEMORY=256mb
JWT_SECRET=$(secret)
LIQUIDITY_BOOTSTRAP_TOKEN=$(secret)
ADMIN_EMAIL=admin@jobradar.my
ADMIN_PASSWORD=$(secret)
BOT_PASSWORD=$(secret)
LIQUIDITY_BOT_PASSWORD=$(secret)
PGBACKREST_REPO1_CIPHER_PASS=$(secret)
BOT_QUOTE_RECONCILE_MS=500
BOT_ORDINARY_RECENTER_MS=15000
BOT_FLOW_DELAY_SCALE=1.2
LOCK_STRATEGY=pessimistic
EOF
chmod 600 "$ENV_FILE"
echo "Created $ENV_FILE (mode 600). Store a secure copy; losing the backup key prevents restores."

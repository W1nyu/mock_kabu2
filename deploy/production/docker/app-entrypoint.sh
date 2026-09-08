#!/bin/sh
set -eu

command_name="${1:-api}"

case "$command_name" in
  api)
    exec node apps/api/dist/main.js
    ;;
  settlement)
    exec apps/settlement/node_modules/.bin/tsx apps/settlement/src/main.ts
    ;;
  matching)
    exec apps/matching-engine/node_modules/.bin/tsx apps/matching-engine/src/main.ts
    ;;
  bots)
    exec apps/bots/node_modules/.bin/tsx apps/bots/src/main.ts
    ;;
  web)
    exec node apps/web/node_modules/next/dist/bin/next start -p 3100
    ;;
  migrate)
    exec packages/db/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma
    ;;
  seed)
    exec packages/db/node_modules/.bin/tsx packages/db/prisma/seed.ts
    ;;
  consistency)
    exec packages/db/node_modules/.bin/tsx packages/db/scripts/check-consistency.ts
    ;;
  recover-settlement)
    shift
    exec packages/db/node_modules/.bin/tsx packages/db/scripts/recover-unsettled-trades.ts "$@"
    ;;
  shell)
    exec /bin/sh
    ;;
  *)
    exec "$@"
    ;;
esac

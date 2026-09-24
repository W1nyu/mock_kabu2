#!/bin/sh
set -eu

command_name="${1:-api}"

case "$command_name" in
  api)
    exec node apps/api/dist/main.js
    ;;
  # Workers run the tsc output built by `pnpm build`: no esbuild transform at
  # start-up and no tsx/esbuild service resident in each 192MB container.
  settlement)
    exec node apps/settlement/dist/main.js
    ;;
  matching)
    exec node apps/matching-engine/dist/main.js
    ;;
  bots)
    exec node apps/bots/dist/main.js
    ;;
  web)
    # `next start` reads .next from the project directory argument; the working
    # directory is /app, so the app path must be passed explicitly.
    exec node apps/web/node_modules/next/dist/bin/next start apps/web -p 3100
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
  oracle-sync)
    shift
    exec packages/db/node_modules/.bin/tsx packages/db/scripts/oracle-sync.ts "$@"
    ;;
  prune-history)
    shift
    exec packages/db/node_modules/.bin/tsx packages/db/scripts/prune-history.ts "$@"
    ;;
  relist)
    shift
    exec packages/db/node_modules/.bin/tsx packages/db/scripts/relist-symbol.ts "$@"
    ;;
  index-add-members)
    shift
    exec packages/db/node_modules/.bin/tsx packages/db/scripts/add-index-members.ts "$@"
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

# One immutable application image is shared by api, settlement, matching-engine,
# bots, migration, and web services. Every long-running process executes compiled
# JavaScript (nest build / tsc / next build); tsx remains only for the one-shot
# seed, consistency and recovery scripts.
FROM node:22-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN corepack enable

# Copy manifests first so dependency installation remains cacheable between source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bots/package.json apps/bots/package.json
COPY apps/matching-engine/package.json apps/matching-engine/package.json
COPY apps/settlement/package.json apps/settlement/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/concurrency/package.json packages/concurrency/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# Next.js embeds this value in the browser bundle at build time. The production
# Compose file supplies https://${APP_DOMAIN}; changing domains requires a rebuild.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN test -n "$NEXT_PUBLIC_API_URL"
# Prisma generate validates the datasource shape but does not contact this placeholder.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

COPY --from=build --chown=node:node /app /app
COPY --chown=node:node --chmod=755 deploy/production/docker/app-entrypoint.sh /usr/local/bin/mock-kabu-entrypoint

USER node

ENTRYPOINT ["/usr/local/bin/mock-kabu-entrypoint"]
CMD ["api"]

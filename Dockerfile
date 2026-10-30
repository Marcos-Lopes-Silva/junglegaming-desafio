FROM oven/bun:1-alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/wiring/package.json packages/wiring/
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages packages
COPY scripts scripts

FROM base AS api
COPY apps/api apps/api
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "apps/api/src/main.ts"]

FROM base AS worker
COPY apps/worker apps/worker
ENV NODE_ENV=production
# O worker só expõe health e /metrics.
EXPOSE 3001
CMD ["bun", "apps/worker/src/main.ts"]

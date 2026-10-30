# syntax=docker/dockerfile:1.7
# One image for every role (ADR-021): TASKMOOR_ROLE=api|worker|realtime|web|all picks what the
# process does. The build runs on the build machine's architecture and only the runtime stage is
# per-architecture, so a multi-arch build does not compile under emulation.
ARG NODE_VERSION=22

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS builder
WORKDIR /src
RUN corepack enable
# Manifests first so dependency installs are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/builder-core/package.json packages/builder-core/
COPY packages/db/package.json packages/db/
COPY packages/devtools/package.json packages/devtools/
COPY packages/formula/package.json packages/formula/
COPY packages/iam/package.json packages/iam/
COPY packages/query/package.json packages/query/
COPY packages/richtext/package.json packages/richtext/
COPY packages/sdk/package.json packages/sdk/
COPY packages/spikes/package.json packages/spikes/
COPY packages/storage/package.json packages/storage/
COPY packages/testkit/package.json packages/testkit/
COPY packages/webconfig/package.json packages/webconfig/
COPY packages/workflow/package.json packages/workflow/
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @taskmoor/server... --filter @taskmoor/web...
COPY . .
# Stamped into the frontend artefact and the server bundle alike (M1-105): the server refuses
# a frontend of another version. Declared here so a new version keeps the install layer cached.
ARG TASKMOOR_VERSION=0.0.0-dev
RUN pnpm --filter @taskmoor/web build && node tools/build/server.mjs

FROM node:${NODE_VERSION}-alpine AS runtime
ARG TASKMOOR_VERSION=0.0.0-dev
# pg_dump and pg_restore for `node cli.mjs backup` and `restore` (OPS-008, OPS-009), one client
# per supported server major (3 MB each): a dump is taken and loaded with the server's own
# version, since a newer pg_restore emits settings an older server rejects.
RUN apk add --no-cache postgresql16-client postgresql17-client postgresql18-client
ENV NODE_ENV=production \
    TASKMOOR_VERSION=${TASKMOOR_VERSION} \
    TASKMOOR_ROLE=all \
    TASKMOOR_WEB_DIR=/app/web \
    TASKMOOR_DATA=/data \
    PORT=8080 \
    HOST=0.0.0.0
# Files and backups live here; owned by the app user so a fresh volume is writable.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
WORKDIR /app
COPY --from=builder /src/apps/server/dist/ ./
COPY --from=builder /src/apps/web/dist/ ./web/
COPY LICENSE ./
USER node
# 8080 serves the app; 9464 is the internal Prometheus endpoint (ADR-023).
EXPOSE 8080 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

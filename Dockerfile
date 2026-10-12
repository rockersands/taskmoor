# syntax=docker/dockerfile:1.7
# One image for every role (ADR-021): TRACKSMITH_ROLE=api|worker|realtime|web|all picks what the
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
COPY packages/db/package.json packages/db/
COPY packages/devtools/package.json packages/devtools/
COPY packages/query/package.json packages/query/
COPY packages/richtext/package.json packages/richtext/
COPY packages/spikes/package.json packages/spikes/
COPY packages/testkit/package.json packages/testkit/
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter @tracksmith/server... --filter @tracksmith/web...
COPY . .
RUN pnpm --filter @tracksmith/web build && node tools/build/server.mjs

FROM node:${NODE_VERSION}-alpine AS runtime
ARG TRACKSMITH_VERSION=0.0.0-dev
# pg_dump and pg_restore for `node cli.mjs backup` and `restore` (OPS-008, OPS-009), one client
# per supported server major (3 MB each): a dump is taken and loaded with the server's own
# version, since a newer pg_restore emits settings an older server rejects.
RUN apk add --no-cache postgresql16-client postgresql17-client postgresql18-client
ENV NODE_ENV=production \
    TRACKSMITH_VERSION=${TRACKSMITH_VERSION} \
    TRACKSMITH_ROLE=all \
    TRACKSMITH_WEB_DIR=/app/web \
    TRACKSMITH_DATA=/data \
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
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

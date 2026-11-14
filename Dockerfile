# syntax=docker/dockerfile:1.7
# One image for every role (ADR-021): TASKMOOR_ROLE=api|worker|realtime|web|all picks what the
# process does. The build runs on the build machine's architecture and only the runtime stage is
# per-architecture, so a multi-arch build does not compile under emulation.
ARG NODE_VERSION=22

# Behind a proxy that re-signs TLS (a company's, or a sandbox's), pass its CA as the build
# secret `build_ca` and the proxy as the usual HTTPS_PROXY build argument:
#   docker build --network host --secret id=build_ca,src=<ca.pem> --build-arg HTTPS_PROXY=... .
# The secret is only mounted for the steps that download, never written to a layer, and the
# proxy arguments are left out of the image's history (docker treats them so).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS builder
WORKDIR /src
RUN corepack enable
# pnpm itself, the version package.json pins (packageManager), fetched in a step of its own so a
# dropped or stalled download is tried again instead of failing or hanging the build (T-236):
# four attempts, each stopped after PNPM_FETCH_TIMEOUT seconds (raise it on a very slow link).
# Corepack checks the download against the npm registry's signing keys as before, and keeps it;
# with its network then switched off, no later step can fetch pnpm outside this retry.
ARG PNPM_FETCH_TIMEOUT=300
COPY package.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    attempt=1; \
    until timeout "$PNPM_FETCH_TIMEOUT" corepack install; do \
      if [ "$attempt" -ge 4 ]; then echo "pnpm: no download after $attempt attempts" >&2; exit 1; fi; \
      echo "pnpm: download attempt $attempt failed or stalled, trying again" >&2; \
      sleep $((attempt * 15)); \
      attempt=$((attempt + 1)); \
    done
ENV COREPACK_ENABLE_NETWORK=0
# Manifests first so dependency installs are cached across source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/api-jira-compat/package.json packages/api-jira-compat/
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
# The dependency install, bounded (T-247): on a slow link it once took 51 minutes, with quiet
# stretches of 16 to 18 minutes. pnpm's network settings come from this step's environment only
# (no .npmrc enters the image): a download that receives nothing for PNPM_INSTALL_FETCH_TIMEOUT
# seconds is dropped and tried again, up to PNPM_INSTALL_FETCH_RETRIES more times after a pause
# of 10 s growing to 2 min, and at most PNPM_INSTALL_NETWORK_CONCURRENCY downloads run at once, so
# a thin link is not split sixteen ways. Through a proxy pnpm bounds only the wait for an answer,
# so the whole step also stops after PNPM_INSTALL_TIMEOUT seconds and says which argument to
# raise. pnpm's store is a build cache outside the image's layers: a build stopped part way, or
# one whose install layer Docker lost, downloads only what the store does not hold yet. None of
# this changes what is installed (the lockfile is frozen and every package is checked against its
# hash), and the arguments are declared here, after the manifests, so a changed value runs this
# step again but keeps every layer above it. pnpm does not ask the registry for a newer pnpm.
ARG PNPM_INSTALL_TIMEOUT=1800
ARG PNPM_INSTALL_FETCH_TIMEOUT=60
ARG PNPM_INSTALL_FETCH_RETRIES=5
ARG PNPM_INSTALL_NETWORK_CONCURRENCY=8
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=taskmoor-pnpm-store,target=/pnpm/store,sharing=locked \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    export npm_config_store_dir=/pnpm/store \
      npm_config_fetch_timeout="$((PNPM_INSTALL_FETCH_TIMEOUT * 1000))" \
      npm_config_fetch_retries="$PNPM_INSTALL_FETCH_RETRIES" \
      npm_config_fetch_retry_mintimeout=10000 \
      npm_config_fetch_retry_maxtimeout=120000 \
      npm_config_network_concurrency="$PNPM_INSTALL_NETWORK_CONCURRENCY" \
      npm_config_update_notifier=false; \
    start=$(date +%s); \
    timeout "$PNPM_INSTALL_TIMEOUT" pnpm install --frozen-lockfile --ignore-scripts \
      --filter @taskmoor/server... --filter @taskmoor/web... || { \
      status=$?; \
      if [ $(($(date +%s) - start)) -ge "$PNPM_INSTALL_TIMEOUT" ]; then \
        echo "pnpm install: stopped after $PNPM_INSTALL_TIMEOUT s, before every dependency was downloaded. What it fetched is kept for the next build. On a slow link, build again with a longer limit (--build-arg PNPM_INSTALL_TIMEOUT=3600) or fewer downloads at once (--build-arg PNPM_INSTALL_NETWORK_CONCURRENCY=4)" >&2; \
      fi; \
      exit "$status"; \
    }
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
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca > /tmp/build-ca.pem; \
      export SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    apk add --no-cache postgresql16-client postgresql17-client postgresql18-client \
    && rm -f /tmp/build-ca.pem
# The server runs `node` alone: the package managers the base image ships (npm, npx, corepack,
# yarn) are removed, with the known vulnerabilities of their own dependencies (M1-118 scan).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
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

# Scan triage

The scans of M1-118 (ADR-104), run on 2026-10-31 in the cloud container, locally and without any
scanner account or token. Every finding has a disposition: **fixed** (with the change and its
test), **false positive** (with why), or **accepted** (with why and where it is tracked). Nothing
high or critical is left open. `scan-results.json` holds the same totals for `pnpm gate M1`.

## What ran, and how to run it again

| Scan | Tool | How it ran here | Result after triage |
|---|---|---|---|
| SAST | Semgrep 1.183.0 (pip, in a virtual environment) | Community rules cloned from their repository (the registry is refused by the network policy): `javascript`, `typescript`, `dockerfile`, `bash`, `html`, `generic`, `yaml` (Compose, Kubernetes, GitHub Actions), `json`; 558 rules; `semgrep scan --metrics=off --config <rules> .` on the tracked tree, then on this task's files | 0 critical, 0 high, 31 medium accepted |
| Dependencies | osv-scanner 2 (built with `go install`), offline database; `pnpm audit` | `osv-scanner scan source --offline-vulnerabilities --download-offline-databases -L pnpm-lock.yaml`; both agree | 0 critical, 0 high, 3 moderate accepted |
| Container image | Trivy 0.76.1 from `mirror.gcr.io/aquasec/trivy` | The runtime stage of `Dockerfile` built from host artefacts (`pnpm --filter @taskmoor/web build`, `node tools/build/server.mjs`), then `trivy image --scanners vuln,secret,misconfig`; the PostgreSQL client packages could not be installed (the proxy refused the Alpine CDN at the time) | 0 after the fix below; the client layer waits for the M1 gate |
| Deployment configuration | Trivy config | `trivy config` on the repository and on `deploy/helm` with `--helm-set database.existingSecret=...` | 0 critical, 0 high in shipped files; 2 medium, 9 low accepted |
| Secrets | gitleaks 8 (built with `go install`) | `gitleaks git --log-opts=--all` over every commit of every branch (315 commits with changes), `gitleaks dir` over the working tree | No real secret; 11 false positives, allowlisted in `.gitleaks.toml` |
| ASVS level 2 review | `asvs-l2.md` | Every requirement against the code and tests | 16 gaps, none high |

To rerun at the M1 gate, on a machine with Docker and network access:

```sh
pip install semgrep && git clone --depth 1 https://github.com/semgrep/semgrep-rules /tmp/rules
semgrep scan --metrics=off --config /tmp/rules/javascript --config /tmp/rules/typescript \
  --config /tmp/rules/dockerfile --config /tmp/rules/yaml .
osv-scanner scan source -L pnpm-lock.yaml && corepack pnpm audit
bash tools/image/smoke.sh && trivy image taskmoor:dev && trivy config .
gitleaks git --log-opts=--all --config .gitleaks.toml . && gitleaks dir --config .gitleaks.toml .
```

Then update `scan-results.json` and this file. The CI security job (`.github/workflows/ci.yml`)
runs Trivy and the SBOM once Actions run again (after M1).

## SAST (Semgrep)

2,538 findings on the tracked tree, 30 more on this task's new files. Severity as Semgrep gives it
(ERROR, WARNING, INFO); ERROR is treated as high.

### ERROR (19)

| Rule | Where | Disposition |
|---|---|---|
| `gcm-no-tag-length` (3) | `packages/iam/src/envelope.ts:74`, `totp.ts:157`, `testing.ts:36` | **Fixed.** AES-GCM opened tags of any length from 4 bytes, so a sealed secret with a cut tag still opened (confirmed: the new tests fail on the old code). `authTagLength: 16` on every cipher and decipher; tests `envelope.test.ts` and `totp.test.ts` "cut short". Severity medium in practice: forging needs write access to the stored value |
| `detect-insecure-websocket` (4) | `origins.test.ts`, `routes/frontends.test.ts` | False positive: `ws://` to the in-process test server |
| `detected-google-gcm-service-account` (4) | `routes/service-accounts.ts` | False positive: the event names `service_account.*` |
| `detected-generic-secret` (3) | `apps/web/src/account/fixtures.ts`, `twofactor/QrCode.test.tsx` | False positive: a synthetic authenticator setup whose secret is ASCII text in base32 |
| `tainted-sql-string` (2) | `packages/testkit/src/pg/databases.ts` | False positive: the test harness drops its own databases, names escaped with `escapeIdentifier` |
| `react-insecure-request` (1) | `apps/web/e2e/kit-server.ts` | False positive: HTTP to the e2e backend on localhost |
| `last-user-is-root` (1) | `deploy/allinone/Dockerfile` | False positive: the entrypoint starts PostgreSQL and the app under their own users with `su-exec` (`deploy/allinone/entrypoint.sh`); nothing serves as root |
| `missing-user-entrypoint` (1) | `tools/ldap/Dockerfile` | False positive: a throwaway OpenLDAP for one test, never shipped |

### WARNING (2,166)

| Rule | Count | Disposition |
|---|---|---|
| `detect-non-literal-regexp` | 16 | **Fixed** for the one that runs input: workflow regex validators ran administrators' patterns on anyone's ticket text in the backtracking engine, so `^(a+)+$` could stall the server (ReDoS). `unsafePattern` (`packages/workflow/src/pattern.ts`) refuses nested repetition, repeated alternation, backreferences and patterns over 500 characters when a workflow is saved (`apps/server/src/workflows/model.ts`) and the engine never runs such a stored pattern (`engine.ts`); tests `pattern.test.ts`, `routes/transitions.test.ts`. The reference engine (the conformance oracle) is unchanged. The rest are false positives: tests, e2e specs, and `upgrade.ts` (built from fixed names) |
| `github-actions-mutable-action-tag` | 31 | **Accepted** (medium): actions are pinned by version tag, not commit hash. Actions do not run until M1 is finished (the user's decision of 2026-10-30); pin them by hash before they run again (M1 gate) |
| `i18next-key-format` | 1,928 | False positive: the rule expects i18next key names; Taskmoor's catalogue uses its own ids (`apps/web/src/i18n/messages.en.ts`) |
| `html-in-template-string` | 96 | False positive: every interpolation into HTML is escaped (`escapeHtml` in `email/render.ts`, `search/subscriptions.ts`; `html()` in `import/report.ts`), or the HTML is the code's own (SAML test IdP, generators, the manual, the Builder) |
| `raw-html-format` | 19 | False positive: SQL templates with `<` comparisons, bound by Kysely |
| `no-replaceall`, `no-stringify-keys` | 94 | Style and portability rules, not security |
| `unsafe-dynamic-method` | 10 | False positive: lookups in fixed tables (`MAPPERS[kind]` in the importers, where kinds come only from `ENTITY_KINDS`, `import/run.ts`); test helpers |
| `detect-redos` | 4 | False positive: the flagged patterns are unambiguous (each repetition ends at a separator: `ldap/settings.ts`, `apps/web/src/sso/client.ts`, `packages/storage/src/s3.ts`, `packages/webconfig/src/config.ts`) |
| `prototype-pollution-assignment`, `prototype-pollution-loop` | 4 | False positive: indexes are numbers the code computed (`reports/flow.ts`, `reports/general.ts`) and fixed case paths (`packages/api-jira-compat/src/cases.ts`) |
| `javascript-confirm` | 3 | Accepted (low): the browser's confirm dialog for destructive actions in three pages; a design-system dialog later |
| `unknown-value-with-script-tag` | 3 | False positive: tests of the Builder's single-file page |
| `react-props-in-state`, `lazy-load-module` | 4 | Not security |
| `direct-response-write` | 1 | False positive: the compatible API sends JSON bodies (`compat/register.ts`) |
| `unknown-value-in-redirect` | 1 | False positive: the OAuth redirect goes only to a registered URI checked just before (`routes/oauth.ts`, `redirectMatches`) |
| Kubernetes and Docker rules (`allow-privilege-escalation...`, `writable-filesystem-container`, `missing-image-version`, `remove-package-*`) | 5 | False positive: test fixtures (`tools/helm/postgres.yaml`, `tools/ldap/Dockerfile`) and the all-in-one image's `FROM ${BASE}` |

### INFO (353)

`missing-template-string-indicator` (145), `react-props-spreading` (92), `jsx-not-internationalized`
(28, all in tests and stories; `pnpm i18n:check` covers components), `detect-replaceall-sanitization`
(18, escaping helpers that do escape), `generic-api-key` (9, the page cursors below),
`dockerfile-source-not-pinned` (3, `node:22-alpine` by tag; pin by digest at release),
`unquoted-variable-expansion-in-command` (2, smoke scripts with fixed values), and three Docker
style notes. None is a vulnerability.

### This task's new files (30)

Same rules as above; nothing new of substance: `detect-non-literal-regexp` in
`packages/ai/src/untrusted.ts` builds from escaped tag names; `html-in-template-string` in the fuzz
harness and `markdown.ts` (the mention address) are not HTML.

## Dependencies

| Package | Version | Advisory | Severity | Disposition |
|---|---|---|---|---|
| storybook, @storybook/addon-vitest, addon-a11y, react-vite | 10.6.1 | GHSA-f2ph-cmg5-wxc8, GHSA-px85-f4q5-jh77 | Critical, high | **Fixed**: 10.6.5 (development only) |
| follow-redirects | 1.16.1 | GHSA-mrwp-f3q8-3g9p | High | **Fixed**: override 1.16.2 (spikes only, through axios) |
| @vitest/mocker (vitest and its browser packages) | 4.1.11 | GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp | Moderate | **Fixed**: 4.1.12 (development only) |
| fast-uri | 3.1.8, 4.2.2 | GHSA-333x-w4r6-6crp, -w74x-v6f9-j3xg, -wjr9-j795-jxcr, -xhq7-xmqj-769h | Moderate, low | **Fixed**: overrides 3.1.9 and 4.2.3 (Fastify's validator) |
| nodemailer | 10.1.0 | GHSA-85x2-q946-cp5h, -8c8m-p3m8-cjg8, -m943-m63m-w62w | Moderate | **Fixed**: 10.1.4, and the test SMTP server's copy by override |
| fastify | 5.12.5 | GHSA-389g-gv7q-r4x8 | Low | **Fixed**: 5.12.7 |
| glob | 13.0.6 | GHSA-3g3m-2fjr-6pw4 | Moderate | **Accepted**: the fix is glob 14 (a major version, through `@fastify/static`); the advisory needs a caller-supplied `AbortSignal`, which `@fastify/static` does not pass. Revisit when `@fastify/static` moves |
| minimatch | 10.2.6, 5.1.9 | GHSA-g3hv-75wg-m249 | Moderate | **Accepted**: the fix is minimatch 11 (major); the patterns are the code's own (static file serving, the SDK generator), never input |

## Container image

The image as built from `Dockerfile`'s runtime stage (`node:22-alpine`, Alpine 3.24.3, Node
22.23.4):

| Finding | Count | Disposition |
|---|---|---|
| Alpine packages | 0 | Nothing found |
| `brace-expansion`, `ip-address`, `pacote`, `picomatch`, `sigstore` (high) and 12 medium, 1 low | 10 high | **Fixed**: they are dependencies of npm and corepack, which the base image ships and Taskmoor never runs. The runtime stage now removes npm, npx, corepack and yarn (`Dockerfile`); a rescan finds nothing, and the image still serves `/health` |
| Secrets in the image | 0 | Nothing found |
| PostgreSQL 16, 17 and 18 client packages | not scanned | **Waiting**: the proxy refused the Alpine CDN when this ran; scan the full image at the M1 gate |

The server bundle (`server.mjs`) is one esbuild file, so image scanners do not see the npm
packages inside it; the dependency scan of the lockfile covers them.

## Deployment configuration

| Finding | Where | Disposition |
|---|---|---|
| DS-0002 image user is root (high) | `deploy/allinone/Dockerfile` | False positive, as `last-user-is-root` above |
| DS-0002 (high), KSV rules (high, medium) | `tools/ldap/Dockerfile`, `tools/helm/postgres.yaml` | False positive: test fixtures, never shipped |
| KSV-0125 images from any registry (medium, 2) | `deploy/helm` workloads | Accepted: the operator chooses the registry (ghcr.io publishing is the user's open decision) |
| CPU limits, UID/GID above 10000, default namespace (low, 8); no HEALTHCHECK in the all-in-one (low, 1) | `deploy/helm`, `deploy/allinone` | Accepted: values the operator sets; the all-in-one inherits the base image's check |

## Secrets

`gitleaks git --log-opts=--all` found 11 matches in the history, `gitleaks dir` the same 11 in the
working tree. **No real secret.** All are false positives, now allowlisted by file and line shape
in `.gitleaks.toml` (a rerun finds nothing):

| Where | What it is |
|---|---|
| `apps/server/src/import/cloud/__fixtures__/compat-source.json` (8) | `nextPageToken` cursors: base64 of `{"s":...,"v":[...],"i":...}`, recorded from Taskmoor's own synthetic server |
| `packages/db/src/upgrade-fixtures.ts` (1) | A storage key of the upgrade seed (`w1/00/11/...`, hex digits in order) |
| `apps/web/src/account/fixtures.ts` (1) | The synthetic authenticator setup (base32 of ASCII text) |
| `apps/server/src/routes/identity.test.ts` (1) | A common password the policy must refuse |

A `gitleaks dir` run with build output present also flags identifier names inside
`apps/server/dist/*.mjs` (third-party code such as `privateKey = body.private_key`); the folder is
ignored by git and not part of the repository.

## Fixes made from the fuzzers and the review

Not scan findings, listed here so the triage holds every fix of M1-118:

| Fix | Found by | Test |
|---|---|---|
| `isSafeHref` read `java\tscript:` and `\u0001javascript:` as relative links | Review, then `pnpm fuzz href` against the URL parser | `markdown.test.ts`, `packages/devtools/src/fuzz/targets.test.ts` |
| Wiki macros after `İ` (which lowercases to two characters) ended in the wrong place | `pnpm fuzz wiki` | `wiki.test.ts` |
| Wiki code blocks kept languages the writer drops | `pnpm fuzz wiki` | `wiki.test.ts` |
| A mention id with a lone surrogate made Markdown output throw (a 500 on `?format=markdown`, a failed notification mail) | `pnpm fuzz wiki` | `wiki.test.ts`, `apps/server/src/fuzz/targets.test.ts` |
| **High:** a table cell with `colspan: 1e308` was stored, and the Markdown and wiki writers laid the span out cell by cell until the process ran out of memory, so reading the ticket as Markdown or mailing a notification about it killed the server. Spans must now be whole numbers from 1 to 1,000 (`adfShapeProblem`, `docShapeProblem`), and both writers cap them for documents stored before (`layoutSpan`, `packages/richtext/src/adf.ts`) | `pnpm fuzz adf` (its watchdog reported the input as a hang) | `convert.test.ts` "table spans", `markdown.test.ts` "huge span" |
| ADF with non-object attributes, non-list content or deep nesting was stored, then failed every read; deep trees exhausted the stack before validation | `pnpm fuzz adf`, `pnpm fuzz rich-text` | `convert.test.ts`, `apps/server/src/fuzz/targets.test.ts` |
| OAuth loopback redirects matched with a user name, password or fragment | `pnpm fuzz addresses` | `apps/server/src/fuzz/targets.test.ts` |
| `AiContext` removed `<ticket>` tags, so `</tic<ticket>ket>` closed the fence | Injection corpus | `packages/ai/src/injection/injection.test.ts` |
| Missing HSTS, `nosniff` and Referrer-Policy on most answers; API JSON without `no-store` and a fixed disposition | ASVS review (14.4, 8.2.1) | `apps/server/src/security-headers.test.ts` |

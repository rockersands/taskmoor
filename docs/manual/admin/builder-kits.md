---
title: "The Builder's kits"
audience: admins
sources: packages/builder-core/src/inputs.ts, packages/builder-core/src/secrets.ts, packages/builder-core/src/manifest.ts, packages/builder-core/src/project.ts, packages/builder-core/src/kits.ts, packages/builder-core/src/backend.ts, packages/builder-core/src/frontend.ts, packages/devtools/src/builder.ts, packages/devtools/src/cli/builder.ts, packages/webconfig/src/config.ts, apps/web/src/api/client.ts, apps/web/src/i18n/messages.en.ts, apps/server/src/config.ts, tools/image/smoke-backend-kit.sh, deploy/README.md, docs/adr/0031-builder-and-two-kits.md, docs/adr/0066-frontend-artefact-and-runtime-config.md, docs/specs/05b-administration-security-and-self-hosting.md
accessed: 2026-10-30
attestation: own-words
---
# The Builder's kits

The Builder turns one set of answers (the addresses, a name, mail settings) into the files an
install needs, with fresh secrets and a signed description of the instance that both halves
share. Today the Builder is a command in the source repository, `pnpm builder`. Taskmoor does
not yet have the web page version of the Builder.

## What the Builder makes

| File | What it is |
|---|---|
| `taskmoor-backend-kit.zip` | For a server with Docker: PostgreSQL, the backend at the exact version and Caddy for HTTPS, with installers and a README of DNS records. For Helm, a values file and a Secret instead |
| `taskmoor-frontend-kit.zip` | The web app for a static host: configured, pinned to its instance, with integrity hashes and the host's fallback files |
| `taskmoor-frontend-single.html` | The whole web app in one `index.html`, for a host that takes one file |

## Running the Builder

You need a copy of the source with its dependencies (`corepack pnpm install`), Node.js 22.12
or later, and a built web app. Build the web app with the version of the backend image you will
run, so both halves agree:

```bash
export TASKMOOR_VERSION=1.0.0
corepack pnpm build
corepack pnpm builder --backend-url https://api.example.com --frontend-url https://tracker.example.com/
```

The three files land in the `kits` folder. Instead of the two addresses you can name a project
file with `--project taskmoor.json`.

| Option | Meaning |
|---|---|
| `--project <file>` | The project file to build from |
| `--backend-url <url>`, `--frontend-url <url>` | Without a project file: the two addresses; everything else takes its default |
| `--web <dir>` | The built web app; `apps/web/dist` by default, or a copy of `/app/web` from the image |
| `--out <dir>` | Where the files go; `kits` by default |
| `--version <x.y.z>` | The backend version the kit pins; `TASKMOOR_VERSION`, else `0.0.0-dev` |
| `--image <repository>` | The image repository; `ghcr.io/rockersands/taskmoor` by default |
| `--seed <seed>` | Derive the secrets from a seed, so a run can be repeated byte for byte |
| `--passphrase-env <NAME>` | The environment variable holding the passphrase of a project file's encrypted secrets |

The addresses must use `https`, except on `localhost`, `127.0.0.1`, `::1` and names ending in
`.localhost` or `.test`. The backend address takes no path. The frontend address ends with `/`,
and its path (`/` or `/tracker/`) is where the app sits on its host. Neither takes a query, a
fragment or a user name. Given as options, the Builder names each problem and exits with code
2; a project file with a wrong address is refused as a whole.

A seed is for tests and repeatable runs: anyone who has it can recreate every secret of the
kit, so never use one you share for a real install.

## The project file

The project file keeps the answers, so you can build the kits again. It is JSON:

```json
{
  "builderVersion": "1.0.0",
  "format": "taskmoor-builder-project-1",
  "inputs": {
    "backendUrl": "https://tracker.example.com",
    "frontendUrl": "https://tracker.example.com/",
    "instanceName": "Acme",
    "routing": "path",
    "target": "compose",
    "smtp": { "host": "mail.example.com", "port": 587, "user": "taskmoor@example.com", "from": "taskmoor@example.com" }
  }
}
```

| Input | Meaning |
|---|---|
| `backendUrl`, `frontendUrl` | Required: where the backend and the web app are reached |
| `instanceName` | Up to 100 characters; shown in the page title |
| `routing` | `path` (clean URLs, the default) or `hash` |
| `target` | `compose` (the default) or `helm` |
| `smtp` | `host`, `port`, `user`, `from`; port 465 means TLS from the start. Values cannot contain spaces |
| `ai` | `provider`: `anthropic`, `bedrock`, `vertex`, `foundry` or `openai-compatible` |
| `defaultLanguage`, `branding.accentColour` | `en` or `es`, and a colour such as `#3366cc`; kept in the file, not yet used by the kits |

The file holds no secret. It can carry the secrets only encrypted with a passphrase
(PBKDF2-SHA-256 with 600,000 rounds, then AES-256-GCM), which `--passphrase-env` opens. The
command line cannot write such a file yet, so every run without a seed makes new secrets and a
new instance identity: a frontend kit built later does not match a backend installed from an
earlier run. Keep the zips of the run you installed.

The command line has no option for the SMTP password or an AI key. When `smtp.user` is set,
add `TASKMOOR_SMTP_PASSWORD=...` to the backend kit's `.env` before you install: the server
refuses to start with a user and no password.

## The connection manifest

Both kits carry the same `connection-manifest.json`, signed with the instance's private key
(Ed25519). It names the instance id and name, its public key and fingerprint, the API and
WebSocket addresses, the allowed frontend origin, the routing mode and base path, and the
backend and kit versions. The Builder refuses to write kits that disagree: the signature, the
addresses, the instance, the key and the routing must match on both sides, and no secret of the
run may appear anywhere in the frontend kit.

The backend kit's `.env` gives the server its identity (`TASKMOOR_INSTANCE_ID` and
`TASKMOOR_INSTANCE_KEY`). The frontend kit's `index.html` pins the instance id and the public
key. When the app starts, it asks the backend's `/api/meta` to sign a fresh random value and
checks the answer. A backend that is not the pinned instance gets **This app belongs to
another server** in place of the app, so nobody types a password into the wrong server.

## Installing a backend kit

The kit for Compose holds `.env` (the settings and every secret of the instance),
`docker-compose.yml`, `Caddyfile`, `install.sh`, `install.ps1`, `README.md` and the manifest.

1. Create the DNS record that `README.md` lists: an A record (and AAAA for IPv6) for the
   backend's name, pointing at the server. Ports 80 and 443 must reach the server.
2. Copy the kit to the server, unzip it and open a shell in its folder.
3. Run `bash install.sh` (on Windows with Docker Desktop:
   `powershell -ExecutionPolicy Bypass -File install.ps1`).
4. Open the setup link it prints, once ([first-run setup](first-run.md)).

`install.sh` checks before it starts anything, and stops with a plain message on the first
problem: Docker installed and running, Compose v2, ports 80 and 443 free (unless the kit's
Caddy already holds them), and the backend's name resolving. `bash install.sh --preflight`
(`install.ps1 -Preflight`) runs only these checks. Then it starts the stack, waits up to three
minutes for the backend, and prints the setup link made from the kit's own setup token. It is
safe to run again.

Caddy gets and renews the HTTPS certificate itself and passes every request to the backend. For
local names (`localhost`, `.localhost`, `.test` and IP addresses) it signs the certificate with
its own authority instead. If ports 80 and 443 are taken, set `TASKMOOR_HTTP_PORT` and
`TASKMOOR_HTTPS_PORT` in `.env`. The backend reads the whole `.env`, so add other settings
there ([configuration reference](configuration.md)). It runs every role and believes Caddy's
forwarded client address.

The backend also serves the web app itself. When the frontend address is the backend's
address, the backend kit is all you need.

### The Helm target

With `"target": "helm"` the backend kit holds `values.yaml`, `secret.yaml` and the manifest
instead. Add your PostgreSQL's `DATABASE_URL` to `secret.yaml`, then:

```bash
kubectl apply -f secret.yaml
helm install taskmoor deploy/helm/taskmoor -f values.yaml
```

The Secret is named `taskmoor-kit`; the values point the chart's database, setup token, pepper
and instance identity at it. See [Kubernetes with Helm](helm.md).

## Putting the frontend kit on a static host

Unzip `taskmoor-frontend-kit.zip` into the folder the frontend address names. The kit holds the
web app's files, `version.json`, the manifest, and an `index.html` with its settings filled in
and an integrity hash on every script and stylesheet. With clean URLs it adds the files hosts
use to send every deep link to `index.html`:

| File | For |
|---|---|
| `.htaccess` | Apache, including shared hosting that reads `.htaccess` files |
| `_redirects` | Netlify and Cloudflare Pages |
| `nginx.conf` | A snippet for the nginx `server` block that serves the kit |

For a frontend address at the root of its host, the nginx snippet is:

```text
location / {
  try_files $uri $uri/ /index.html;
}
```

With hash routing no host rule is needed. The single file `taskmoor-frontend-single.html` holds
the scripts and styles inside it and always uses hash routing, since one file cannot answer
deep links; it cannot use a strict Content-Security-Policy, which the zip form allows. Rename it
to `index.html` where the host expects that name.

## What is not there yet

- **Signing in from another origin.** The web app sends its session cookie only to its own
  origin, so a frontend kit on another origin than the backend (another host name or port)
  cannot sign in yet. Until it
  can, serve the frontend from the backend's own origin, for example from a host that passes
  `/api/` and WebSocket traffic through to the backend, or let the backend serve the web app.
- **Settings the server does not read yet.** The backend kit's `.env` also carries
  `TASKMOOR_ALLOWED_ORIGINS`, `TASKMOOR_TOKEN_SIGNING_KEY`, `TASKMOOR_MASTER_KEY`,
  `TASKMOOR_AI_PROVIDER` and `TASKMOOR_AI_KEY`. They are kept for later releases; today they
  change nothing.
- **The web page Builder**, which runs the same core in a browser with no network access.

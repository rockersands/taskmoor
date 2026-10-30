# ADR-070: The meta endpoint, the instance identity and the frontend version window

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-106

## Context

ADR-032 promised a public meta endpoint and an N-1 compatibility window, and the requirements
fill in the details:
- API-017: before showing anything, a frontend learns:
  - the API version;
  - the frontend versions the backend works with;
  - how people sign in (public SSO details only);
  - who the instance is: id, name and public key.
  It also asks the instance to sign a nonce, so a kit built for instance A refuses to run
  against instance B.
- API-018 and NFR-010: a backend serves the previous release's frontend, and anything older
  says "update required" instead of failing quietly.
- OPS-017 (2): a frontend one version behind shows an "update available" notice.

M1-105 made the frontend a versioned artefact, but the bundle did not know its own version,
and the instance had neither an identity nor a key.

## Decision

- **Instance identity.** The first request that needs it creates an id (UUID) and an Ed25519
  key pair, kept in `instance_setting` under `identity`:
  - The private key is sealed with the password pepper, like TOTP seeds, so a copy of the
    database cannot sign as the instance.
  - When processes race to create it, the first one written wins.
  - The identity never changes by itself. A restore brings the old one back. A missing pepper
    leaves the public half readable and signing refused (`503 identity_unavailable`), rather
    than quietly making a new instance that every pinned kit would reject.
  - The fingerprint is `SHA256:` plus the base64url digest of the key's SPKI DER.
- **`GET /api/meta`** sits outside `/api/v1` because it is how a client picks a version. It
  needs no sign-in and sets no cookie, and every value in it is public, so it answers
  `Access-Control-Allow-Origin: *`. It holds:
  - product, backend version, API version and base;
  - the frontend window;
  - the instance's id, name, key algorithm, public key and fingerprint;
  - sign-in methods: password, plus each enabled provider's name, protocol, issuer, OIDC
    client id, SAML sign-in URL and start URL. Never a secret.
  - With `?nonce=` (16–128 base64url characters), a signature: Ed25519 over the three lines
    `taskmoor-meta-v1`, the instance id and the nonce. Binding the id stops one instance from
    replaying another's answer.

  It is a stable operation (`getMeta`) in the API document. The contract test validates a
  real answer against it, and the SDK has a method for it.
- **Version window.** Releases are minor versions (NFR-010). Backend x.y gives
  `minimum = x.(y-1).0` and `recommended = x.y.0`:
  - A frontend below the minimum must update. Below the recommended version it should update.
  - At x.0 the minimum is x.0.0, because a major release breaks the API on purpose.
  - A development build (a prerelease, a `git describe` between tags, or a commit id) names no
    window and takes any frontend.

  The rule lives in `@taskmoor/webconfig` so backend and frontend share it, along with the
  signed text and a Web Crypto check (`verifyInstance`) for kits.
- **The frontend's side.** The build stamps `__TASKMOOR_WEB_VERSION__`, the same version as
  `version.json`. `VersionGate` asks the meta endpoint at start and every 30 minutes, since a
  backend can be upgraded under an open tab:
  - Below the minimum, it shows an "Update required" page in place of the app.
  - Below the recommended version, the shell shows a notice above every page with "Reload" and
    "Not now".
  - When the endpoint cannot be reached, it says nothing; the page's own requests will show any
    real failure.
- **N-1 testing.** The API half already runs in every gate: `breakingChanges` checks the
  current document against the released baseline (`docs/api/baseline`, ADR-067). The release
  checklist replaces that baseline with each release's document. The frontend half, the
  previous release's kit running its core e2e against the new backend, needs two releases and
  the Builder's kits (M1-110, M1-111). It stays pending until then, and the release checklist
  carries it (ADR-032).

## Options considered

| Option | For | Against |
|---|---|---|
| Ed25519 identity sealed with the pepper (chosen) | Small keys and signatures; Web Crypto verifies it in current browsers and Node; the pepper already protects other read-back secrets | A lost pepper stops signing, by design |
| An HMAC over the nonce with a shared secret | No key pair | The kit would have to hold the secret |
| The TLS certificate as identity | Nothing new to store | Proxies terminate TLS; it changes on renewal; a kit cannot read it from script |
| Meta under `/api/v1` | One prefix | The version negotiator would itself be versioned |
| Frontend versions listed by hand in a file | Any policy | One more thing to forget at each release; the rule follows from NFR-010 |
| Block every request from an old frontend on the server | The server enforces it | Breaks scripts and tokens that send no frontend version; the client knows best what it can render |

## Consequences

- Kits (M1-110, M1-111) pin the id and public key in their connection manifest and call
  `verifyInstance`. The connected-frontends list (OPS-017) can read the version a kit reports.
- A frontend newer than its backend is treated as current. If that ever matters, the window
  could gain a maximum.
- Rotating the instance key means every kit pins the new one. That needs a procedure (sign
  the new key with the old one) when M1-110 lands.

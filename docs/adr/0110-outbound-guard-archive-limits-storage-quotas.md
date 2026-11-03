# ADR-110: An outbound guard for requests to typed addresses, archive limits and storage quotas

- Status: Accepted
- Date: 2026-11-02
- Backlog: M1-118 (ASVS level 2 gaps 5.2.6, 12.6.1, 12.1.2, 12.1.3)

## Context

The ASVS level 2 review (`docs/security/asvs-l2.md`) left four rows of Group B open before the
M1 gate:

- **5.2.6 and 12.6.1 (SSRF, outbound allow list).** The server sends requests to addresses
  people type: webhook receivers, AI providers, identity providers. Any of them could aim the
  server at its own loopback, the private network behind it or a cloud metadata service
  (169.254.169.254), and a name checked once can be answered differently a moment later (DNS
  rebinding).
- **12.1.2 (archives).** A Data Center backup ZIP was staged, and a Taskmoor export ZIP
  unpacked, with no ceiling on what they unpack to: a small ZIP bomb could fill the disk.
- **12.1.3 (quotas).** Attachments had a maximum file size (12.1.1) but no total per person or
  workspace. CORE-021 says there is no storage quota: the product does not cap storage the way
  hosted trackers do.

## Decision

**One outbound guard** (`apps/server/src/outbound/guard.ts`, `addresses.ts`). `guard.fetch` is a
`fetch` built on `node:http` and `node:https`, and every server-side request to a typed
address goes through it:

| Request | Where | Typed by |
|---|---|---|
| Webhook deliveries | `webhooks/deliver.ts` | site administrator |
| AI providers (Anthropic API with a base URL, Bedrock, Vertex AI, Foundry, OpenAI-compatible) | `app.ts` passes `adapterOptions.fetch` to `AiService`, so every adapter of `packages/ai` uses it | site administrator |
| OpenID Connect discovery, key set, token endpoint, user info | `sso/oidc.ts` (`openid-client`'s `customFetch`) | site administrator |
| Cloud REST import | `import/cloud/client.ts` `fetchTransport` | site administrator |
| The new-version check (ADR-117) | `updates/check.ts` `githubReleases` | nobody: a fixed address |

- **Checked addresses.** The host is resolved and every address it resolves to is checked; one
  that may not be reached refuses the request. Refused: unspecified, loopback, private
  (RFC 1918, `fec0::/10`, local NAT64), shared address space (CGNAT, `100.64.0.0/10`),
  link-local, unique local (`fc00::/7`), multicast, reserved and documentation ranges, and
  the metadata addresses of the large clouds by name. IPv6 forms that carry an IPv4 address
  (mapped, compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are judged by that address; an
  address literal is checked before connecting.
- **Pinned.** The check is the connection's `lookup`: the socket connects to the address that
  was checked, so a second DNS answer cannot replace it. Keep-alive connections are reused only
  for the same host and port, and were made to a checked address.
- **Redirects.** `manual` and `error` work as in `fetch`; `follow` follows at most five
  redirects, each through the same check, and drops `authorization` and cookies when the origin
  changes. Webhooks and OpenID Connect use `manual`, the Cloud import `error`.
- **Only `http:` and `https:`.**
- **Operator allow list.** `TASKMOOR_OUTBOUND_ALLOW` takes host names, `*.domain`, addresses and
  CIDR ranges, comma-separated (for example `ollama.corp.example,10.20.0.0/16`). A named host
  is reached at whatever it resolves to; a range lets any host that resolves into it through.
  The host of `TASKMOOR_AI_BASE_URL` is allowed too: the operator set it. A bad entry stops the
  server at start.
- **Refusals** throw `OutboundRefused`, whose message names the host, the address and the
  reason, never headers. A webhook delivery refused this way fails at once, without retries.

Not guarded, on purpose: SMTP (`TASKMOOR_SMTP_URL`), the S3 endpoint, ClamAV, the OTLP
exporter and the embedding endpoint (`TASKMOOR_EMBEDDINGS_URL`) come from the operator's own
environment, not from anyone's typing, and usually sit on the internal network. LDAP
directories are typed by a site administrator but are internal by nature and are not HTTP; they
are listed here as a known exception. The CLI tools (`import/cli.ts`, `mcp/stdio.ts`,
`load/cli.ts`) run on the operator's machine against their own server. SAML metadata is pasted,
never fetched. Vertex AI and Bedrock fetch credentials from the metadata service through their
own SDKs (application default credentials, instance roles), which stays possible.

**Archive limits** (`apps/server/src/import/archive.ts`). Before anything is unpacked, the ZIP's
central directory is held to three ceilings: the uncompressed total (512 GiB), the ratio of
uncompressed to compressed size (200 to 1, for each entry above 1 MiB and for the archive above
64 MiB) and the number of entries (10 million). yauzl checks every entry's stream against the
size its directory declares, so an entry that lies fails when it passes it. The defaults suit a
backup of a million tickets with tens of gigabytes of attachments: XML compresses 10 to 30
times, attachments hardly at all; a single-layer ZIP bomb reaches about 1,000. The operator
raises them with `TASKMOOR_ARCHIVE_MAX_GIB`, `TASKMOOR_ARCHIVE_MAX_RATIO` and
`TASKMOOR_ARCHIVE_MAX_ENTRIES`. They apply where the server unpacks an uploaded archive: the DC
backup stage (and the import route's check), and the Taskmoor export ZIP (whose half-written
folder is now removed when unpacking fails). Attachment ZIPs are only listed and streamed one
entry at a time, already under the file size limit.

**Storage quotas** (`apps/server/src/attachments/quota.ts`, migration 0082). Two columns on
`attachment_setting`, a workspace total and a limit per person, in bytes, **both off by
default**: CORE-021 keeps storage uncapped, and the operator, who owns the disk, chooses. A site
administrator sets them through `PUT /api/v1/admin/attachment-settings` (the same route, event
`attachment_settings.updated`, audit and token class as the maximum file size) and on the
guardrails page, which shows the workspace's usage and the heaviest uploader's against them.
An upload that would pass a quota is refused with 413 `storage_quota_exceeded`, naming the
quota, the limit, the usage and the room left: at once when nothing is left or Content-Length
says so, else when the stream passes the room left. The insert re-checks under advisory locks
per person and per workspace, so two uploads at once cannot both take the last room. Usage is
summed from a new index `attachment (workspace_id, author_id) INCLUDE (size)`, and only when a
quota is set. Imports count toward usage but are not refused.

## Options considered

| Option | For | Against |
|---|---|---|
| Guarded `fetch` on `node:http` with a checking `lookup` (chosen) | No dependency; the check is the connection's own resolution, so pinning needs no second step | A small `fetch` of our own (bodies are buffered, which suits JSON calls) |
| `undici` `Agent` with `connect.lookup` | The platform's own fetch underneath | A new dependency whose Agent must match Node's bundled undici |
| Resolve, then fetch the URL with the address in it | Simple | Breaks TLS name checks and SNI; HTTPS would need the host name anyway |
| Check only when the address is saved | Simple | DNS changes after saving; rebinding defeats it |
| Quotas on by default | Stronger out of the box | CORE-021 and the operator's own disk; a default number would be arbitrary |
| Quota usage kept in a counter table by triggers | Constant-time reads | Triggers on every attachment row, also in bulk imports; the index-only sum is enough when a quota is set |

## Consequences

- Webhook receivers, AI servers (Ollama, vLLM) and identity providers on the internal network
  need `TASKMOOR_OUTBOUND_ALLOW`. The manual's configuration, webhook, AI and sign-in pages say
  so; the error message names the setting.
- Tests that run a fake provider on loopback pass a guard that allows it
  (`testing/outbound.ts`); the end-to-end server sets the variable as an operator would. Tests
  resolve names through an injected resolver, never DNS.
- The guard buffers request bodies; a streamed upload to a typed address would need a
  streaming path first.
- Revisit when M2 brings outbound web requests in automation (AUT-007) and extensions with an
  allow list (EXT-001): both reuse the guard.

## Changes

- 2026-11-02, the user's decision: storage quotas are **on by default for new installations**:
  first-run setup writes 1 TiB for the workspace and 20 GiB a person
  (`DEFAULT_STORAGE_QUOTA`, `routes/setup.ts`), filling only quotas still empty. An install
  upgraded through migration 0082 keeps none until an administrator sets them, so no upgrade
  refuses an upload it accepted before. CORE-021 and the manual say so.

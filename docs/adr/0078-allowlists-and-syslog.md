# ADR-078: IP allowlists matched in each process, and the audit log forwarded to syslog by cursor

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-085

## Context

M1-085 brings into release 1.0 (the user's decision of 2026-10-30) IP allowlists for the UI and
every API (IAM-015, specified for M2), an audit log page, and an audit export as a file
download and to syslog. Continuous SIEM streaming with CEF, HTTPS and OpenTelemetry (IAM-014)
stays in M2 (M2-018). The audit log itself, its hash chain, search, export API and retention
exist (ADR-034). IAM-015 asks for no entry cap, per-group exemptions and lock-out protection
for the administrator applying a rule; ADR-006 keeps Postgres the only store.

## Decision

- **The list** (migration 0062): `ip_allowlist` per workspace (on or off, exempt group ids) and
  `ip_allowlist_entry` rows (an `inet`: an IPv4 or IPv6 address with its prefix, and a note),
  with no cap. A site administrator replaces it whole with `PUT /api/v1/admin/ip-allowlist`;
  each change emits `ip_allowlist.updated` with what was added and removed, which the audit
  log records.
- **Matching in each process.** The list is read at most every 30 seconds per process, at once
  after a change through it, and compiled into a Node `BlockList`; a request costs a lookup in
  memory, not a query. An IPv4-mapped IPv6 address counts as its IPv4 address.
- **Where it applies.** A hook after authentication refuses, with `403 ip_not_allowed`, every
  request from outside the list to the API (sign-in, administration and MCP included) and to
  the web app this process serves, except the health probes. A member of an exempt group gets
  in from anywhere; for the web app's own files the session cookie is read only when the
  address is outside. A frontend kit on another host is outside our reach, but everything it
  asks the API is not.
- **Lock-out protection.** Saving an enabled list that leaves the caller outside (by address
  and by exempt group) answers `409 would_lock_you_out` unless the request carries
  `confirmLockout: true`; the page asks first. `cli.mjs allowlist-off`, run on the server,
  turns every list off for someone who locked themselves out anyway.
- **The audit log page** (Settings > Audit log) builds on the existing API: search with day and
  action filters, the CSV and JSON Lines downloads of what the filter finds, the chain check,
  retention (with "forever"), and the syslog receiver.
- **Forwarding to syslog** (`audit/syslog.ts`): one receiver per workspace (`audit_syslog`:
  host, port, `udp`, `tcp` or `tls`, and `last_seq`). Every ten seconds a worker sends what the
  log gained after `last_seq`, oldest first, up to 5,000 records in batches of 500, as RFC 5424
  messages (facility 13, log audit; severity notice; MSGID the action) whose text is the record
  as JSON, the same fields as the JSON Lines download. TCP and TLS frames are octet-counted (RFC
  6587); UDP sends one datagram each. The row is locked (`FOR UPDATE SKIP LOCKED`) for the run,
  so several workers do not send twice, and `last_seq` moves only past what was handed over: a
  receiver that was down gets what it missed, from the last error on. A new receiver starts at
  the newest record; the downloads have the past. Delivery is at least once: a run that fails
  after the receiver took part of a batch sends that part again.

## Options considered

| Option | For | Against |
|---|---|---|
| Allowlist in each process from Postgres (chosen) | No new store; a memory lookup per request | Up to 30 s for a change made through another process to apply |
| Leave allowlists to the reverse proxy | Nothing to build | No group exemptions, no lock-out protection, nothing in the audit log, a different recipe per proxy |
| Syslog by cursor over the audit table (chosen) | No backlog to keep; catches up after an outage; reuses the export's batches | At least once, not exactly once; up to ten seconds late |
| Syslog from the event bus as events happen | Immediate | Records written straight to the log (refused sign-ins, exports) are not events; an outage loses what happened during it |

## Consequences

- With several API processes, a change through one reaches the others within 30 seconds.
- A list of many thousands of ranges is fine: `BlockList` checks them in memory.
- Forwarding to syslog over UDP can lose messages without anyone knowing; the page recommends
  TLS. A receiver with its own certificate authority needs the server's trust store
  (`NODE_EXTRA_CA_CERTS`).
- M2-018 (continuous SIEM streaming) can reuse the cursor and the message format, and add CEF,
  HTTPS and OpenTelemetry senders beside `sendSyslog`.
- External-user policies by email domain (IAM-004), named in M1-085's title, are not built here:
  they need a decision on what an external person may not do (see HANDOFF).

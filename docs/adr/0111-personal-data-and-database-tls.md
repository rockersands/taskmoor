# ADR-111: A person's data, downloaded and erased; TLS to the bundled PostgreSQL

- Status: Accepted
- Date: 2026-11-02
- Backlog: M1-118 (ASVS level 2 gaps 8.3.2 and 1.9.1)

## Context

Two ASVS 4.0.3 level 2 items stayed open for the M1 gate (`docs/security/asvs-l2.md`):

- **8.3.2:** people have a way to take out and remove their data. Administrators could export
  the whole workspace and deactivate accounts, but nobody could download one person's data, and
  nothing removed a person. IAM-008 (2) asks that erasing a user replaces name and email with an
  anonymous label everywhere, history and exports included, while tickets stay.
- **1.9.1:** communication between components is encrypted. With an external PostgreSQL the
  operator sets `sslmode=verify-full`; the bundled PostgreSQL of the Compose kits talked plain
  TCP on the kit's private network, and the all-in-one image used TCP on 127.0.0.1.

The audit log is append-only and hash-chained per workspace (ADR-034): a record's hash covers
its actor, subject, details, address and times, and `audit-verify` recomputes every hash. Any
rewrite of a record, even replacing an email by a placeholder, breaks the chain from that record
on, and a trigger refuses updates anyway.

## Decision

### A person's data as a download

- A person asks on their profile page (**Your data**, `POST /api/v1/account/data-exports`); a
  site administrator asks for anyone from the People page (`POST /api/v1/users/:id/data-exports`).
  Each request is a row in `personal_export` (migration 0083) and a job (`privacy.export`); one
  request per person and requester runs at a time. The person's routes are session-only: an API
  token cannot take a person's data out.
- The job streams a ZIP into the attachment store (the active one; S3 or local disk), registered
  as an upload first so a dying job leaves no file behind (ADR-040). It holds `profile.json`
  (account, groups, teams, single sign-on identities, second factors by kind and name, API tokens
  by name and scope, sessions), `preferences.json` (notification and email settings, properties,
  saved searches), `track-groups.json` (the person's track groups and those shared with them,
  ADR-121), `tickets.ndjson` (reported, created or assigned, with the roles),
  `comments.ndjson`, `time-entries.ndjson`, `attachments.ndjson` with the files themselves,
  `audit.ndjson` (records the person caused or that are about them) and `manifest.json` last,
  with each file's records, bytes and SHA-256. Secrets never: no hash, token, sealed secret or
  link.
- A download the person asked for shows ticket content only where they may see the ticket now
  (the authorizer's list predicate); others appear by id and role. Their own comments, time and
  files are theirs and always included. An administrator's download has everything: they may
  export the whole workspace anyway. In audit records someone else caused, that person's address
  is left out.
- Only whoever asked downloads it (`.../download`), for seven days; then the worker's housekeeping (every five
  minutes) marks it expired and hands the file to the storage sweep. Rows go a month later.

### Erasure

`POST /api/v1/users/:id/erase` with `confirmEmail` (the person's email as typed), site
administrators only, in one transaction, emitting `user.erased`:

- Refused: the last active site administrator, oneself, service accounts (not people), an
  account a directory or SCIM still manages (the next sync would bring it back: remove the person
  there first), an erased account, and a confirmation that is not the account's email. Someone
  else's role never refuses it: the first build's `last_track_admin`, for a share that gave the
  only other person running a track their role, became "that person keeps the role" (ADR-121,
  T-205a, 2026-11-13).
- The `app_user` row stays, so every reference keeps working: name `Former user <id>`, email
  `erased-<id>@erased.invalid` (a reserved domain, so it can never receive mail or match a real
  address), no password, time zone or locale, not an administrator, deactivated, `erased_at`
  set. Editing or reactivating it is refused. The placeholder is derived from the id alone, so
  it is stable and says nothing about the person.
- Removed: sessions with the OAuth tokens under them, API tokens, second factors, recovery
  codes, sign-in challenges, password links, single sign-on identities, directory and SCIM links,
  preferences, notification settings, notifications and the record of emails sent, unsubscribe links, saved-search mailings to them, recently viewed tickets, stars, outbox receipts, the AI notice acknowledgement,
  properties, imported-identity mappings, sign-in counters under the email, and the person's
  downloads with their files. Taskmoor stores no avatar (IAM-008 lists one; none is built yet).
- Their track groups go, with what their shares gave others, and the shares they received go
  with what those gave them, by ADR-121's rules for taking a share back; `user.erased` lists those
  roles (`groupAccess`), and the roles that stayed with the last person running a track as their
  own (`groupAccessKept`). Roles given otherwise are kept, as below.
- Their capacity in Multi-track plans goes with its notes (ADR-122), and the scrub job below
  empties those notes in the plans' `plan.capacity_set` events (T-089j).
- Kept: tickets, comments, time, attachments, group and team memberships, grants, saved searches
  and dashboards they own, all attributed to the placeholder. The exception is a permission to
  create tracks that came with a role, which goes as on any deactivation, from the person and from
  anyone whose last role their shares took back; `user.erased` lists it
  (`createTracksGrantsRemoved`; ADR-118, T-087b).
- Domain events about the person (created, updated, provisioned) have the old name and email
  replaced in their payload, in the same transaction, while the old values are still known.
- Names copied into other records are replaced by a job (`privacy.scrub`), which finds them by
  the id alone, so its payload never holds the old name: history display names of People fields
  (assignee, requester, user custom fields; in a list only the person's entry changes), mention
  labels in descriptions, environments, comments, earlier comment versions and the history of
  rich text fields. For each document it changes, the collaboration state and the original in
  another format are dropped; both are rebuilt from the document. Free text that names the
  person (someone typed their name) is not found: administrators edit it.

### The audit log stays as written

Audit records are never rewritten. They keep the account's id, which now names the
placeholder, so the actor's name and email shown in the log are the placeholder's. Records
about an erased person (subject `user:<id>`) still carry personal values in their details (the
email in `user.created`, a typed email in a failed sign-in): the log hides those when it is read,
searched, exported or sent to syslog (`audit/query.ts` `maskDetails`, keys `email`, `name`,
`displayName`, `userName`, `givenName`, `familyName`, including `{ from, to }` changes), and drops
the address of every request the erased person made. Such records are marked `masked: true`;
their `hash` covers the stored record, which `audit-verify` checks unchanged. The stored values
leave with the partition that holds them when retention drops it (ADR-034). The same applies to
an erased person's capacity notes in a plan's `plan.capacity_set` records, whose subject is the
plan: they are shown empty (T-089j), there and in the `audit.ndjson` of anyone's data download
(`audit/query.ts` `withoutErasedCapacityNotes`). This is the
exception GDPR article 17 (3) allows for records kept for security and legal claims; the
manual says so.

### TLS to the bundled PostgreSQL

- The Compose kit and the Builder's backend kit run a one-shot `postgres-tls` service before
  PostgreSQL at every start, in the PostgreSQL image (it has `openssl`), as root. The first
  start makes a private certificate authority (P-256, 20 years) and a server certificate for
  `postgres` and `localhost` (P-256, 10 years, server authentication only). Later starts keep
  both and reissue only a server certificate that is missing, fails to verify, or expires within
  90 days; the authority stays, so the backend's trust never changes. It also writes
  `pg_hba.conf`: TLS and a password (SCRAM) for every network connection, plain TCP rejected,
  the container's own socket trusted (the image's health check and setup scripts).
- The authority's key is in the `postgres-ca` volume, mounted only into `postgres-tls`. The
  `postgres-tls` volume holds the server key (mode 0600, owned by the PostgreSQL user), the
  certificates and `pg_hba.conf`; PostgreSQL and the backend mount it read-only, and the backend
  (user `node`) cannot read the server key.
- PostgreSQL runs with `ssl=on`, `ssl_min_protocol_version=TLSv1.2`, that certificate and that
  `pg_hba.conf`; the backend's `DATABASE_URL` ends in
  `sslmode=verify-full&sslrootcert=/db-tls/ca.crt` (node-postgres checks the chain and the host
  name; `pg_dump` and `pg_restore` read the same parameters).
- Keys and certificates are made on the machine the kit runs on; none is in the repository, the
  image or a kit. One text (`packages/builder-core/src/postgres-tls.ts`) defines the service, the
  command line and the URL for both kits; a test holds `deploy/compose/docker-compose.yml` to it.
- Upgrades: `upgrade.sh` runs `docker compose up -d postgres` before it stops the backend when
  the kit has `postgres-tls`, so an install made with an earlier kit gets its certificate and
  restarts PostgreSQL with TLS once when its Compose file is replaced; the data volume is taken
  over as it is. A dry run reports that step and stops before the database checks.
- The all-in-one image runs PostgreSQL with `listen_addresses=''` (also passed on the command
  line, for volumes whose `postgresql.conf` an older image wrote) and the backend connects on the
  Unix socket (`postgresql:///taskmoor?host=/run/postgresql&user=postgres`). The traffic never
  leaves the container and is no network traffic, which is the evidence for 1.9.1 there.

## Options considered

| Option | For | Against |
|---|---|---|
| Anonymise audit records in place | The log shows nothing personal | Breaks the hash chain, `audit-verify` fails from the first changed record; needs the append-only trigger lifted |
| Version-2 records hashing field digests, so values can be blanked | Erasable values with an intact chain | Only for new records; a second record format for the verifier, for a rare operation |
| Keep audit records, mask on read, retention removes them (chosen) | Chain intact; nothing personal shown; standard retention exemption | The stored values remain until retention; whoever reads the database directly sees them |
| Rewrite history and mentions in the erase request | One step | A seq scan of `ticket_change` at 1M tickets inside a request; the job is resumable and idempotent |
| Store the old name in the scrub job to find free text | Finds more | The job table keeps payloads for ever: the erased name would persist there |
| TLS certificates from the install script on the host | Matches "install script" literally | Needs `openssl` on the host (Windows, the Builder's kit), and an upgrade without the script would have none |
| Certificates made by a Compose service (chosen) | Every `up` (install, upgrade, by hand) gets one; no host tool needed | One more short-lived container per start |
| Document the private network as the boundary | No change | ASVS 1.9.1 asks for encryption between components; the gate wanted it closed |
| A certificate library in Node instead of `openssl` | No dependency on the image's tools | A new dependency or a hand-written X.509 encoder; the PostgreSQL image has `openssl` |

No new dependency.

## Consequences

- People and administrators can satisfy an access request and an erasure request from the UI;
  both are audited (`personal_data.export_requested`, `user.erased`).
- Downloads need an attachment store; without one the request answers 503 `storage_unavailable`.
- An erased person's old values stay in the stored audit records until retention drops them.
  If an operator must remove them sooner, the only way is a shorter retention (which drops whole
  months); revisit with version-2 records if that becomes a requirement.
- A live co-editing session open during an erasure may write back a document with the old
  mention label; the next scrub run (or another erasure run) fixes it. Embeddings of changed
  documents are recomputed by the usual sweep.
- The bundled PostgreSQL refuses plain TCP. Tools that connected to it in plain text from
  another container on the kit's network need `sslmode=require` or better (and the CA for
  `verify-full`). External PostgreSQL is unchanged: the operator's `DATABASE_URL` decides.
- What the image smoke tests show (`tools/image/smoke-kits.sh`): the all-in-one PostgreSQL has
  no listen address and every backend connection is on the socket; in the Compose kit every
  backend connection is TLS, a plain TCP connection is refused, `verify-full` by host name is
  accepted, and the authority is the same after `upgrade.sh`.

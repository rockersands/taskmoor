# Track invitations and track managers' pages: tasks

Workstream `claude/track-invites`, for 1.0. Decisions in `docs/adr/0118-track-invitations.md`;
requirements IAM-027 to IAM-030 in `docs/specs/05a-administration-security-and-self-hosting.md`;
manual page `docs/manual/admin/invitations.md`. Numbers used: ADR-118, migration 0087.

| Task | State |
|---|---|
| Permissions `invite_people` and `appoint_track_admins`, in the catalogue and migration | Done |
| Role-giving rule on role actors, invitations, owner changes and local-mode policies | Done |
| The last administrator of a track | Done |
| `track_invitation` table, upgrade seed, schema golden | Done |
| Invite, list, resend, withdraw, inspect, redeem, accept; events, audit, scopes, erasure, pruning | Done |
| Invitation emails in English and Spanish | Done |
| Single sign-on opens an invitation, also with account creation off | Done |
| Tracks you run, a track's Manage page, the invite dialog, the invitation page | Done |
| Strings in English and Spanish, stories with axe, phone layout, e2e spec | Done |
| Manual, ADR, spec, API document | Done |

## Handoff

See the report of this workstream for what ran and with what result; the full gate is the
coordinator's. Not done on purpose, per the brief: importing people from outside services,
reCAPTCHA, anything specific to one identity provider.

The follow-up for Google sign-in with personal addresses builds on `invitationOpensAccount` in
`apps/server/src/routes/invitations.ts`. Two things to weigh then:

- `provider.domains` must include the personal domain, and a provider then also reaches every
  address there that has a live invitation or, with account creation on, any address at all.
- Single sign-on does not ask for Taskmoor's second factor. An external person who comes in through
  a provider therefore skips the two-factor rule for external people (IAM-004, M1-085).

Other loose ends, each named in ADR-118: rate limits are per process; the role list shows an
existing person's name to the manager who invited them; a copied link lets its holder make the new
account without proving the mailbox.

# ADR-109: Security notices, failed authentication in the audit log, and alert rules

- Status: Accepted
- Date: 2026-11-02
- Backlog: M1-118 (ASVS 2.2.3, 2.5.5, 7.1.3, 7.2.1, 7.2.2, 11.1.7, 11.1.8)

## Context

The ASVS level 2 checklist of ADR-104 left seven rows open in one family, security events:

- people were not told when their credentials changed (2.2.3, 2.5.5): `user.password_changed`
  and the second-factor events were audited, not mailed;
- failed authentication was partly audited (password and second factor at sign-in, password
  checks), without how it was tried; refused API tokens, Basic authentication on the
  Jira-compatible API and refused requests (403) were only counted by the throttle or written
  to the request log as status codes (7.1.3, 7.2.1, 7.2.2);
- nothing watched for unusual activity (11.1.7, 11.1.8). AI spend alerts existed (ADR-100) but
  reached no one: they waited for "an administrator notification channel".

The notification pipeline of M1-056 to M1-058 is built for tickets: notifications join a
ticket, honour each person's channels, digests and quiet hours, and carry an unsubscribe link.
A security notice must do none of that. The audit log is append-only and hash chained
(ADR-034): whatever is written there stays, so refusals must not be written one per request.

## Decision

**Notices** (`apps/server/src/security/notices.ts`, `mail.ts`). A bus subscriber, `security`,
reads the credential events and writes one `security_email` row per event, person and kind:
`password_changed` (not for the activation of a new account: the event now carries the link's
optional `purpose`), `two_factor_enabled`, `two_factor_disabled` (with the method),
`recovery_codes_regenerated`, `two_factor_reset`, and `email_changed`, which it reads from
`user.updated`, `scim.user_updated` and `directory.user_updated` and sends to the **old**
address, the new one masked (`n***@example.org`). The row fixes the address when it is written;
the other notices go to the address the account has then, so a reset made just before an email
change is told at the new address while the change itself is told at the old one.
A mailer on the worker sends them every 15 seconds, one email each: no batching, no digest, no
quiet hours, no preference, no unsubscribe link. It uses the SMTP server of M1-057. Templates
are English and Spanish, by the reader's locale; times in the reader's time zone. A notice says
what changed, when, the address and User-Agent of the request, who made it (the person, an
administrator, or the identity service for SCIM and directories), and how to get help. Its only
link is the instance's sign-in page; it never holds a token. A failed send is tried again at
later runs, ten times at most, with the last error kept. Sent rows go after 30 days; the audit
log keeps the events.

To say where a change came from, **domain events keep the request's User-Agent** next to its
address (`domain_event.user_agent`, migration 0081, filled from the request scope like the
address; a context's own `userAgent`, `null` included, wins). An alert keeps the address and
User-Agent of the request that reached its threshold; the payload names whom it is about.

**Failed authentication** (`audit/record.ts`, `tokens/bearer.ts`, `compat/register.ts`).
`session.sign_in_failed` now carries `method` (`password`, `directory` for LDAP and Active
Directory, `totp`, `webauthn`, `recovery_code`, `enrollment`, `api_token`, `basic`), `reason`
(`wrong_password`, `unknown_account`, `second_factor`, `sso_required`, `directory_unavailable`,
`token_unknown`, `token_expired`, `token_revoked`, `token_owner_deactivated`, `not_a_token`,
`email_mismatch`), the account when one matches (or the email typed, when it looks like one),
the address and the User-Agent; for a token Taskmoor knows, its id. Never the password, code or
token. Refused API tokens were throttled per address already; Basic authentication refused by
the compatible API is now throttled the same way (50 in 15 minutes, then 429). Attempts refused
while locked are neither audited nor counted, as before, so a flood cannot fill the log.

**Refusals in aggregate** (`security/refusals.ts`). Every 403 under `/api/` to a signed-in
person or a token counts for that person or token in the `access_refusals` window; the audit
log gets `access.refused_repeatedly` when the count reaches 10, and again at 100, 1,000 and each
tenfold, with the count, the window and the last route pattern. A flood of refusals writes a
handful of records. The count runs in `onSend`, before the answer leaves; a failure to count is
logged and never turns the refusal into an error. Anonymous refusals have no one to count against
(the request log has them); the compatible API's own routes are not counted, the native routes
they call are.

**Alert rules** (`security/alerts.ts`). Four rules count events per key in fixed windows
(`security_counter`) and raise one alert per rule, key and window (`security_alert`, unique),
emitted as `security.alert_raised`, with no actor:

| Rule | Counts | Key | Default |
|---|---|---|---|
| `sign_in_failures_account` | failed sign-ins and password checks | the account, or the email typed | 10 in 60 minutes |
| `sign_in_failures_address` | the same, plus refused tokens and Basic credentials | the client address | 25 in 15 minutes |
| `access_refusals` | 403 answers | the person or the token | 50 in 15 minutes |
| `bulk_exports` | workspace, audit log and search result exports | the person | 5 in 60 minutes |

The defaults sit below the throttle's own limits (an account locks progressively after 5
failures, about 12 an hour get through; an address locks at 50 in 15 minutes), so an attack is
reported before the throttle hides its later attempts. A refused token does not count against its
owner's account: a forgotten script with an expired token is not an attack on a password. A
right password refused because the domain must use single sign-on counts for nothing.

The `security` subscriber sends each alert to every active site administrator (by the account
flag, or a `site_admin` grant to them, to everyone or to a group they are in, nested groups
included; at most 200): an **inbox** item about no ticket (`ticket: null`, with `alert`), marked
as a direct ask so it shows in Priority, and an **email**. The same happens to the AI spend
alerts of ADR-100 (`ai_limit.threshold_reached`, inbox event `ai_spend_alert`), which closes that
ADR's open item. The inbox shows alert items only while the reader is a site administrator; the
web inbox renders them with the rule, the count and whom they are about, linking to the audit log
(or the AI usage page). `security.alert_raised` and the settings event are audited, so they also
reach syslog and webhooks.

**Settings.** `GET` and `PUT /api/v1/security/alerts` (site administrators; the admin token
scope by the `/api/v1/security` prefix) read and set each rule's switch, threshold (1 to
100,000) and window (1 to 1,440 minutes), and list the latest 20 alerts; a change emits
`security_alerts.updated`. The Security page has a form for them (`SecurityAlertsForm`). Rules
are read per process with a 15-second cache, like the session policy. Counting goes on when a
rule is off, so the refusal audit keeps working.

No new dependency.

## Options considered

| Option | For | Against |
|---|---|---|
| Notices as ordinary notifications (`notification` rows, the M1-057 mailer) | One pipeline | Ticket-shaped (join, visibility recheck, unsubscribe, digests, preferences): every rule would need an exception |
| **A `security_email` table and its own mailer** (chosen) | No preference or digest can hold a notice; the address is fixed when written | A second, small mailer |
| Notices written in each route | The request's User-Agent at hand | Eight routes and two background jobs (SCIM, directory sync) to remember; one missed path is a silent gap |
| **A subscriber, with the User-Agent on the event** (chosen) | One place sees every path | A column on `domain_event` |
| Audit every 403 | Simple | A refusal loop floods an append-only log that cannot be pruned early |
| **Aggregate per person or token, tenfold steps** (chosen) | A handful of records per window | The log shows counts, not each refused route |
| Sliding windows over the audit log | Exact | A query of the log on every failure; refusals are not in it |
| **Fixed windows in a counter table** (chosen) | One upsert per event | A burst split by a window edge can reach twice the threshold before alerting |

## Consequences

- People hear of every credential change, whoever made it; administrators hear of bursts of
  failed sign-ins, refusals and exports, and of AI spend, in the inbox they already read.
- A 403 now costs one upsert. A flood of refusals is bounded by the rate limits (M1-066).
- The inbox reads notifications with outer joins on the ticket so alert items fit; the ticket
  items' rule is unchanged. `inbox.large.test.ts` (50,000 items) measured a first page at 17 ms
  p95, the count at 16 ms, a later page at 18 ms, against its 250 ms budget.
- IAM-018 (anomaly detection, M3) is started: its mass export case is covered by count, not yet
  by volume (50,000 tickets); new countries, impossible travel and new networks remain for M3.
- Revisit when M2 brings SIEM streaming (IAM-014): alerts could go out through it too.

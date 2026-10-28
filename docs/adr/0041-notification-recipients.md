# ADR-041: Notification recipients resolved by a bus subscriber, redacted per recipient

- Status: Accepted
- Date: 2026-10-28
- Backlog: M1-056

## Context

NTF-001 asks for notification policies that map events to recipient types (spec 01c
section 3), shared or local to a track, with a default policy, and requires that recipients
never receive content for tickets they cannot see. NTF-004 asks for per-event, per-channel
personal choices. Email (M1-057) and the inbox (M1-058) come later and need one record of who
was told what. The domain event bus (ADR-015) already delivers every change at least once to
subscribers after its transaction commits.

## Decision

- **Policies are configuration data** like field rule sets (ADR-009): `notification_policy`
  (shared, or a local-mode track's own) and `notification_rule` rows of an event and a
  recipient type (assignee, requester, area owner, user, group, track role, followers, track
  owner, current user, user field, group field). Each workspace has a default policy (assignee,
  requester and followers for every built-in event); `track.notification_policy_id` chooses
  another. A save replaces a policy's rules as a whole. A transition's own event is
  `custom:<name>`.
- **A bus subscriber resolves recipients** (`apps/server/src/notifications/subscriber.ts`).
  It maps the domain event to a notification event (`ticket.updated` becomes
  `ticket_assigned` when the assignee changed, `ticket_close_reason_set` when a close reason
  was set, `ticket_updated` otherwise; a transition's own event wins, else its stages name it:
  closed, reopened, work started, work stopped, generic), reads the rules of the ticket's
  policy, expands groups (nested ones included) and roles to people, and keeps only active
  people who may see the ticket through the authorization service, visibility level included
  (ADR-012, M1-020), and for a restricted time entry only its role or group. The person who
  made the change is left out unless they asked to hear of their own changes.
- **One row per recipient and channel** in `notification`, unique per domain event, person and
  channel, so a second delivery of the same event writes nothing. A person's off switches
  (`notification_preference`, no row means on) remove channels before the row is written. The
  row holds the ticket key, summary, event type and the names of changed fields, never field
  values: email and the inbox render from the ticket as the recipient may see it.
- **Recipients are judged when the event is handled**, a moment after the change, against the
  ticket as it then is.

## Options considered

| Option | For | Against |
|---|---|---|
| Subscriber after commit, rows per recipient (chosen) | Writes cost nothing extra; retries are free (idempotent rows); email and inbox share one record | Recipients reflect the ticket a moment later, not the exact committed state |
| Resolve recipients inside the write transaction | Exact state | Slows every write by group expansion and one authorization check per recipient; a failure blocks the write |
| Resolve at delivery time in each channel | No stored rows | Email and inbox would each repeat the resolution and could disagree; no record of who was told |

## Consequences

Channels (M1-057 email with batching and digests, M1-058 inbox) read `notification` rows and
render content with the recipient's own permissions. Comments (M1-018) add `ticket_commented`
with the comment's restriction checked like a restricted time entry. A policy with many group
or role recipients costs one authorization check per person per event; if that becomes slow,
the checks can be batched through the list predicate (`visibleTicketIds`).

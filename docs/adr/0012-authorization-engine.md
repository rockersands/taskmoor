# ADR-012: Authorization engine: in-process evaluator over Postgres with a permission cache

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-018

## Context

Every request, search, notification, export and realtime push must answer "may this user do
this here" (IAM-009 to IAM-012) and search must apply browse permission inside the query, not
after it (QRY-008). The budget is a check p95 under 10 ms at 100,000 users and 30,000 tracks,
and a search pre-filter that adds at most 10 ms to a query (first stated as under 20% of the
unfiltered query; made absolute by the user on 2026-10-12, because a relative budget on
sub-millisecond queries measures noise). Atlassian built a central
authorization service for this; the research recommended an OpenFGA-style relationship model.

## Decision

- **The model is relationship-based**, OpenFGA style: users belong to groups (nested groups
  flatten on write); tracks reference an access policy; a policy grants each permission to
  grantees (track role, group, user, track owner, any signed-in user, anyone, and the ticket-level
  grantees requester, assignee, user field and group field); tracks name the actors of their
  roles; visibility levels add members per ticket. The explainer (IAM-012) returns the grant that
  decided a check.
- **Evaluation is in-process SQL**, not a co-process. One statement returns every permission a
  user holds in a track (`packages/spikes/src/authz/evaluator.ts`, `PERMISSIONS_SQL`); a
  per-process LRU cache keyed by (user, track) holds those sets and the user's allowed-track
  list, invalidated through the change log (ADR-013) whenever memberships, policies, role
  actors or visibility levels change. Ticket-level grantees and visibility levels are evaluated
  against the ticket row after the track check.
- **The search pre-filter** is the allowed-track list from the same tables
  (`ALLOWED_SPACES_SQL`), cached per user, compiled into the query as
  `space_id = ANY($allowed)`, or as `space_id <> ALL($denied)` when the user sees most tracks,
  or dropped for site administrators. Visibility levels add a ticket predicate.
- **Fitness tests** keep every route behind a check and every search behind the pre-filter
  (ADR-030).

## Measurements (spike, 2026-10-12)

100,000 users, 5,000 groups, 30,000 tracks, 600 policies, 342k memberships, 305k role actors,
48k grants; 2,000 random checks each, one at a time, on a machine whose disk was busy with
another benchmark ([report](../spikes/authz.md)):

| Candidate | Check p50 / p95 ms | Allowed tracks p95 ms (median 24k tracks) | Setup | Mismatches vs reference |
|---|---:|---:|---:|---:|
| In-process SQL, cold | 1.14 / 1.47 | 123 | 5 s load | 0 |
| In-process SQL, cached | 0.00 / 0.00 | 123 | | 0 |
| OpenFGA 1.22 co-process, Postgres store | 8.83 / 15.9 | 249 | 754k tuples in 116 s | 0 |

The in-process check meets the budget cold and is free when cached; OpenFGA misses it at p95
and needs a second service, a tuple mirror of every membership and grant, and its ListObjects
call for the pre-filter is twice as slow. All three agree on every check.

## Options considered

| Option | For | Against |
|---|---|---|
| In-process SQL evaluator with cache (chosen) | Within budget; one service; transactional with the data; explainer is the same query | We own the evaluator (about 100 lines of SQL) and its invalidation |
| OpenFGA co-process | Mature model language, audited engine | 15.9 ms p95; second process per install; every membership and grant mirrored as tuples; eventual consistency unless its cache is off |
| SpiceDB | Same model family, strong consistency tokens | Same co-process cost; Go service with its own datastore |
| Permission checks after the query | Simplest | Counts, pages and charts leak; the spec forbids it |

**Pre-filter overhead** on the 200k-ticket benchmark dataset, allowed lists of 10%, 50% and 90%
of the tracks compiled as `space_id = ANY($allowed)`
([report](../spikes/authz-overhead-200k.md)): the filtered query is faster than the unfiltered
one when the filter is selective (`mine-open` -44%), equal within noise otherwise, and at worst
1.3 ms slower in absolute terms on sub-millisecond queries (`status-priority-in`, 0.8 to 2.1 ms
with 10% of tracks allowed, where the planner switches to the track index). On every query
above 2 ms the 20% budget holds. The 10M run repeats the measurement.

## Implementation (M1-002)

`apps/server/src/authz/authorizer.ts` with tables `role`, `access_policy`, `access_grant`,
`track` (its permission columns), `track_role_actor` and `global_grant`. Two choices differ from
the spike:

- **Nested groups are resolved in the query** with a recursive CTE rather than flattened on
  write; nesting is shallow and the check stays within budget (test: p95 under 10 ms uncached
  with 10,000 grants, 400 users and 300 tracks). Flattening remains the fallback if a real
  directory makes the recursion slow.
- **Cache invalidation uses an epoch per workspace** (`authz_epoch`), moved by triggers on every
  permission-relevant table, until the change log (M1-031) can carry finer signals. A request
  reads the epoch once; cached sets from an older epoch are ignored, so a revoked grant takes
  effect at the next request.

Site administrators (the account flag, or a `site_admin` global grant, also through a group)
hold every permission in every track and need no search filter; configuration administrators
hold `administer_track`, `manage_layouts`, `edit_workflows` and `view_readonly_workflow`
everywhere. Ticket-level grantees never grant at track level; M1-020 applies them per ticket.
A property test checks the service against a plain reference model on 10,000 random grants.

**Archived tracks (M1-006, CORE-025)** are read-only for everyone, site administrators
included: the permission set computed in an archived track is cut down to the read
permissions (`ARCHIVED_TRACK_PERMISSIONS`: browse, aggregated data, development tools,
read-only workflow, voters and followers), and `allowedTracks` leaves archived tracks out.
A site administrator may pass `includeArchived` for a read permission to search the archive;
everyone else's request is answered without it. With an archived track present, a site
administrator's pre-filter is the list of active tracks instead of 'all'. Archiving moves the
epoch (a trigger on `archived_at`), and the explainer reports `trackArchived`. The reference
model archives one track in five.

## Consequences

Policies, roles and memberships are ordinary tables, so imports (IMP-005) and the admin UI
need no second system. The cache's invalidation depends on the change log, so ADR-013's
sequence must cover permission tables.

# ADR-012: Authorization engine: in-process evaluator over Postgres with a permission cache

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-018

## Context

Every request, search, notification, export and realtime push must answer "may this user do
this here" (IAM-009 to IAM-012) and search must apply browse permission inside the query, not
after it (QRY-008). The budget is a check p95 under 10 ms at 100,000 users and 30,000 spaces,
and a search pre-filter that adds at most 10 ms to a query (first stated as under 20% of the
unfiltered query; made absolute by the user on 2026-10-12, because a relative budget on
sub-millisecond queries measures noise). Atlassian built a central
authorization service for this; the research recommended an OpenFGA-style relationship model.

## Decision

- **The model is relationship-based**, OpenFGA style: users belong to groups (nested groups
  flatten on write); spaces reference a permission policy; a policy grants each permission to
  grantees (space role, group, user, lead, any signed-in user, anyone, and the item-level
  grantees reporter, assignee, user field and group field); spaces name the actors of their
  roles; security levels add members per item. The explainer (IAM-012) returns the grant that
  decided a check.
- **Evaluation is in-process SQL**, not a co-process. One statement returns every permission a
  user holds in a space (`packages/spikes/src/authz/evaluator.ts`, `PERMISSIONS_SQL`); a
  per-process LRU cache keyed by (user, space) holds those sets and the user's allowed-space
  list, invalidated through the change log (ADR-013) whenever memberships, policies, role
  actors or security levels change. Item-level grantees and security levels are evaluated
  against the item row after the space check.
- **The search pre-filter** is the allowed-space list from the same tables
  (`ALLOWED_SPACES_SQL`), cached per user, compiled into the query as
  `space_id = ANY($allowed)`, or as `space_id <> ALL($denied)` when the user sees most spaces,
  or dropped for site administrators. Security levels add an item predicate.
- **Fitness tests** keep every route behind a check and every search behind the pre-filter
  (ADR-030).

## Measurements (spike, 2026-10-12)

100,000 users, 5,000 groups, 30,000 spaces, 600 policies, 342k memberships, 305k role actors,
48k grants; 2,000 random checks each, one at a time, on a machine whose disk was busy with
another benchmark ([report](../spikes/authz.md)):

| Candidate | Check p50 / p95 ms | Allowed spaces p95 ms (median 24k spaces) | Setup | Mismatches vs reference |
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

**Pre-filter overhead** on the 200k-item benchmark dataset, allowed lists of 10%, 50% and 90%
of the spaces compiled as `space_id = ANY($allowed)`
([report](../spikes/authz-overhead-200k.md)): the filtered query is faster than the unfiltered
one when the filter is selective (`mine-open` -44%), equal within noise otherwise, and at worst
1.3 ms slower in absolute terms on sub-millisecond queries (`status-priority-in`, 0.8 to 2.1 ms
with 10% of spaces allowed, where the planner switches to the space index). On every query
above 2 ms the 20% budget holds. The 10M run repeats the measurement.

## Consequences

Policies, roles and memberships are ordinary tables, so imports (IMP-005) and the admin UI
need no second system. The cache's invalidation depends on the change log, so ADR-013's
sequence must cover permission tables.

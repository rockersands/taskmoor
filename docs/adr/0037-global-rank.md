# ADR-037: Global rank with fractional keys and a sequence for new tickets

- Status: Accepted
- Date: 2026-10-26
- Backlog: M1-008

## Context

Boards and backlogs share one order over all tickets (AGL-009): ranking a ticket on one board
shows on every board that holds it, a ticket moves to the top or the bottom or between two
others through the API, and 1,000 consecutive moves must never need a rebalance users can
see. Imported rank orders must come across exactly (M1-093). Tickets are created in parallel
(M1-008 asks for 1,000 parallel creates), and a new ticket lands at the bottom.

Jira solves this with LexoRank: string keys in buckets, with a periodic rebalance. We need the
same properties without copying its design: a key that sorts as a string, so the order is one
index scan, and a move that writes one row.

## Decision

- **Rank keys are fractional strings** (`apps/server/src/tickets/rank.ts`) over the 62 digits
  `0-9A-Za-z`, stored in `ticket.rank` with the "C" collation so the database compares them
  byte by byte whatever its locale. A unique index on `(workspace_id, rank)` makes the order
  total; there are no ties to break.
- **A key is an integer part and an optional fraction.** The integer part's first character
  gives its length (`a` to `z` for non-negative integers with 1 to 26 digits, `Z` down to `A`
  for negative ones), so integers sort as strings and grow by one character per factor of 62.
  A fraction never ends with 0, so there is always room between two keys.
- **New tickets take the next value of a sequence** (`ticket_rank_seq`), encoded as an integer
  key. Sequences never hand out a value twice and never wait, so parallel creates neither
  block each other nor clash. Only sequence keys ever extend the order at the bottom (a move
  to the bottom takes one too), so every new sequence key sorts after every key in use.
- **A move takes a key between its new neighbours**, from the middle half of the gap and at
  random within it. Two moves into the same gap at the same moment rarely pick the same key;
  when they do, the unique index refuses the second, which retries with fresh neighbours (up
  to five times). A move writes only the moved ticket's row and does not change its version,
  so it never conflicts with someone editing the ticket's fields.
- **Moves to the top** take a key below the smallest in use; the negative integers give room
  for that without fractions.

## Measurements

Property tests (`rank.test.ts`): random appends, moves to the top and inserts keep one strict
order; every later sequence key sorts after every key in use. 1,000 consecutive moves into
the same gap grow the key to about 190 characters, far below the index's 2,700-byte limit; 1,000
moves to the top stay under 10 characters; ten million appends need 5 characters. Twenty
concurrent moves into one gap all succeed with distinct keys (`tickets.test.ts`).

## Options considered

| Option | For | Against |
|---|---|---|
| Fractional keys, sequence for appends (chosen) | One row per move; parallel creates never wait; keys stay short for the common cases | Repeated moves into one gap lengthen keys until a background rebalance |
| Integer positions | Simple to read | A move renumbers everything after it; contention on every board |
| Fractional keys with the bottom computed from the largest key | No sequence | Parallel creates pick the same key; serialising them needs a lock per workspace |
| Floating-point positions | Compact | Precision runs out after about 50 moves into one gap |

## Consequences

The rank of a ticket is a plain column the query compiler (ADR-010) can sort on. Boards and the
backlog (M1-047) only send "before", "after", "top" or "bottom". A ticket whose key grew long
from many moves into one spot can be given a fresh key by a background job that rewrites a
small range of neighbours; M1-047 adds it if real use needs it. The importer (M1-093) can write
imported orders as sequence keys in order, which reproduces them exactly.

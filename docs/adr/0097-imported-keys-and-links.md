# ADR-097: Keys and links from the tracker an import came from

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-128

## Context

IMP-011 asks Taskmoor to keep track keys, ticket numbers and key aliases, and to redirect the
source's URL patterns to the imported objects: visiting `/browse/ABC-42` on the new host opens the
imported ABC-42, and a ticket moved from OLD-5 to NEW-9 is reachable by both keys. M1-128 also
asks for the old filter and board links. Tickets already keep their keys and numbers (M1-089),
and a moved issue's earlier keys are replaced rows of its key history, which `resolveTicket` and
the query catalogue read (M1-091, ADR-092). The backend serves the frontend in hash or clean URL
mode (M1-134), and the frontend also ships as a static kit on any host (M1-105). Saved filters,
dashboards (M1-094) and boards (M1-093, M1-095) carry external ids by the source's ids. The API's
authentication runs for `/api/` paths only; page paths carry no session.

## Decision

- **One list of the source's link patterns, for both sides** (`packages/webconfig/src/links.ts`,
  in our own words, each **Verify**): `/browse/ABC-42` (whatever follows: a comment's id, a
  fragment), `/projects/ABC/issues/ABC-42` and `/browse/ABC` need no lookup and become
  `#/tickets/ABC-42` and `#/tracks/ABC`; `/issues/?filter=<id>`,
  `/secure/IssueNavigator.jspa?requestId=<id>`, `/secure/RapidBoard.jspa?rapidView=<id>` and
  `/secure/Dashboard.jspa?selectPageId=<id>` become `#/imported/<kind>/<source id>`; a `jql`
  query becomes `#/search?q=...`, which the native parser reads in the Jira-compatible
  vocabulary. Anything else is not a link of the source.
- **The backend redirects them when it serves the frontend** (`frontend.ts`): any GET (any client,
  not only browsers) for one of those paths gets a 302 to its route, as a path in clean URL mode
  and as a fragment in hash mode, under the base path. API paths are never read as links.
- **The app reads them too** (`routing/ImportedLinkPage.tsx`): a static host in clean URL mode
  hands the app any path, and the hash redirect of unknown paths brings them there in hash mode,
  so the app maps the same patterns and goes on with `router.redirect` (in place of the current
  history entry, with a change event, so Back does not return to the old link).
- **Ids map through the import's external ids, for a person who may see the result**
  (`GET /api/v1/imported-links/:kind/:sourceId`, kinds `saved-search`, `board`, `dashboard`). The
  newest mapping of that kind and source id wins (several `system` names may hold one). It answers
  the target id and the app's route only to someone signed in who sees the target; anyone else,
  and an id no import mapped, gets the same 404, so a link never confirms that something hidden
  exists. Page paths carry no session, which is why the backend's redirect stops at the app's
  `#/imported/...` route rather than looking the id up itself; that page is the one place that
  resolves it, signed in. Boards resolve as soon as the board import writes their external ids.
- **Earlier keys open tickets, and the address shows the current key.** A moved ticket opens by
  its earlier key through its key history (ADR-092); the ticket API already answers with
  `redirect: {from, to}`, and the ticket page now rewrites the address to the current key without a
  new history entry. A renamed project's first key (`originalkey`) becomes an earlier key of its
  track (`TrackCommand.formerKeys`, a replaced row of `track_key_history`), so its tickets open,
  and queries find them, by either key; a key another track holds stays theirs with
  `former_key_taken`. This replaces the warning `original_key_not_kept`.

## Options considered

| Option | For | Against |
|---|---|---|
| Shared pattern list, server redirect to app routes, ids looked up by the signed-in app (chosen) | Works with the bundled server and static kits alike; id mappings stay behind sign-in | Two hops for filter and board links |
| Resolve ids in the server redirect | One hop | Page paths carry no session: anonymous visitors could map ids; static kits would need their own lookup anyway |
| Redirect everything to `/#/...` and map only in the app | No server change | `/browse/ABC-42` would not redirect for clients without JavaScript, and clean URL mode keeps the old path in the address |
| Keep a redirect table per import | Explicit | Duplicates the external ids every import already writes |

## Consequences

- `/browse/ABC-42` opens ABC-42 in both routing modes, and OLD-5 and NEW-9 open the same ticket
  (end-to-end: `apps/web/e2e/imported-links.spec.ts` on both served modes; server:
  `routes/imported-links.test.ts` with a real import of 1,200 issues, seed 128, a renamed project
  and every moved issue). Old filter, board and dashboard links redirect, and an unknown one says
  that nothing imported matches.
- The generator gains `renamedProjects` (off by default, so earlier fixtures do not change).
- Not done: comment and attachment anchors of an issue link (`focusedCommentId`) are dropped;
  links to a project's board or reports in the newer URL shapes, wiki pages and other apps' links
  are not mapped; projects renamed more than once (`ProjectKey` rows) keep only their first key.
  Every pattern is **Verify** until design partners' links confirm them.

# ADR-044: Comments, their restriction, versions and reactions

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-018

## Context

CORE-020 asks for rich-text comments with mentions, reactions, permalinks, edit and delete by
own/all permissions, and visibility restricted to a role or group: a restricted comment is
invisible to others "in UI, API, search, notifications and export"; editing marks a comment
edited and keeps earlier versions for administrators. NTF-001 (3) adds that recipients never
receive content of restricted comments they cannot see. The backlog's measure: a restricted
comment is never returned to an unauthorised user on any read path. Time entries (M1-019)
already restrict to a role or group the same way; per-status locks (ADR-042) can reserve
commenting; transitions (WF-006) take a comment.

## Decision

- **Data** (migration 0041). `ticket_comment` holds the document (the shared schema, as
  descriptions), the author, an optional role or group, a version counter, the last edit and a
  soft delete. `ticket_comment_version` keeps each replaced state (text, restriction, who wrote
  it and who replaced it). `ticket_comment_reaction` holds one row per person, emoji and
  comment. The restriction columns have no foreign key: a comment whose role or group is gone
  stays restricted and fails closed (its author only), and deleting a group is never blocked.
- **One reading rule**, `readsComment` (`tickets/comments.ts`): a person reads a comment when
  they see its ticket and it is open, theirs, or for a role they hold in the ticket's track or
  a group they are in (nested groups included). Site administrators are not exempt, as for
  visibility levels (M1-020). `commentReadableSql` is the same rule for set-based readers;
  search and export (M1-037 and later) must use it.
- **Read paths.** The list and the permalink apply the rule; the history keeps a comment's id
  only (never its text) and hides the rows of comments the reader may not read; notifications
  of a new comment go only to its readers and the mailer checks again at send time, quoting the
  text only then (a deleted comment's notifications are dropped); events and audit never carry
  the text. Earlier versions are read through one route, for site administrators only, deleted
  comments included: the deliberate exception CORE-020 (3) asks for.
- **Writes.** "Add comments"; "Edit/Delete own comments" or "all"; a status's `comment` lock
  holds for adding, editing and deleting (reactions are not comments). A restriction names a
  role of the workspace or a group the writer is in. Deleting is soft. A new or deleted comment
  is a history row and touches the ticket's updated time, not its version (an edit in another
  tab is not made stale by a comment). No formula reads the updated time, so no formula
  refresh is needed; one that ever does must be refreshed here too.
- **Reactions**: any emoji, one grapheme (pictographs with modifiers and joiners, flags,
  keycaps); putting one twice or removing one never given changes nothing and emits nothing.
- **Transitions** take `comment` and `commentVisibility`, written in the transition's
  transaction under the same checks; the transition's event names the comment (`commentId`),
  and its notifications quote it to those who may read it.
- **Formats**: comments are written and read in `?format=` (`doc`, `adf`, `markdown`) like
  descriptions; an ADF original is not kept for comments (the importer, M1-086, may add it).

## Options considered

| Option | For | Against |
|---|---|---|
| One rule in code and its SQL twin (chosen) | Lists stay cheap: the audience is read once, only when a restricted comment is on the page | Two forms of one rule to keep in step |
| A per-comment ACL table | Set-based everywhere | Duplicates role and group membership, which changes without the comment |
| Hard delete with a tombstone in history | Simpler | Loses the versions administrators must keep |

## Consequences

- New read paths for comments (search, export, the inbox M1-058, the ticket view M1-051) must
  apply `readsComment` or `commentReadableSql`; the matrix test in `routes/visibility.test.ts`
  lists the ticket's paths.
- Mention notifications (NTF-005) and replying by email (NTF-009) build on these tables.
- Bulk comment actions (CORE-024) wait for the comment route to be callable as a `Caller`
  handler (ADR-043).

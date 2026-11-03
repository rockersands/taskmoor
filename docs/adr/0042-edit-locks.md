# ADR-042: Per-status locks and per-field edit permissions, explained to the person

- Status: Accepted
- Date: 2026-10-28
- Backlog: M1-029

## Context

WF-007 asks that a status can reserve editing, commenting, attaching, assigning and moving a
ticket on to named roles or groups: in status Approved only role Approvers edit, others see
read-only fields, and the API answers 403 (1); the UI says why a field is read-only (2). The
workflow model already stores these lists per status (`statusPermissions`, ADR-039), and the
transition route has refused with them since M1-027. Every other write path ignored them. The
backlog adds per-field edit permissions: fields only some roles or groups may set, whatever
track permissions others hold. Field rule sets (ADR-009, M1-012) already decide per ticket type
which fields are required or hidden, so they are where a field's editors belong.

## Decision

- **Locks narrow, never grant.** A person needs the track permission for an action and, where a
  lock applies, to hold one of its roles or groups. Site administrators are not exempt, as with
  visibility levels (ADR-012): they add themselves to a role or change the configuration.
- **Status locks on every write path.** `apps/server/src/workflows/locks.ts` reads the
  published workflow's lists once per track (cached by workflow version, which never changes)
  and the person's roles and groups before the write's transaction, then checks the status of
  the locked ticket row inside it. Edit covers every field change, a move to another track and
  co-editing rich text (M1-017); assign covers assignee changes; attach covers uploading and
  removing files; transition stays with the engine. Comment is enforced by comments (M1-018).
  An empty list lets nobody through, as the workflow engine reads it.
- **Field editors live in field rules.** A rule's `editableBy` lists `{roleId}` and `{groupId}`
  (migration 0038, a JSON column on `field_rule`). It applies wherever the person sets a value:
  create, edit, transition layouts and co-editing. A field cannot be both required and
  restricted (others could never create the ticket), nor hidden and restricted. A stored list
  this release cannot read lets nobody set the field.
- **Refusals carry the lock.** 403 `{error: 'forbidden', permission, locks}`: `permission` is the
  refused action (`edit`, `assign`, `attach`, `transition`, or `edit_field`), each lock says
  what refused (`by: 'status'` with the status, or `by: 'field'` with the field) and who may
  (`allowed`: type, id and name). The transition refusal keeps its `reason` text and adds
  `locks`.
- **The UI is told before it asks.** `GET /api/v1/tickets/:id/locks` lists the status locks
  that apply to the person; the create and edit layouts carry `locks` (the edit lock of the
  status, then each field lock); the attachment list carries `locked`. The client words a lock
  in the reader's language from those parts ("In status Approved, only the Approvers group can
  add or remove files"; "Only the Approvers group can set this field") and shows the control
  read-only with that sentence as its description. Reading one ticket also answers
  `editableFields` (T-191): the fields the person may change now, from the same checks as an
  edit (the permission each field needs, the status's edit or assign lock, field rules, the
  edit layout, computed fields), so the ticket page and pop-up show controls only there and
  values elsewhere. The answers to an edit and a transition carry it too, with `mayEdit`, worked
  out for the ticket as the change left it: a new assignee or requester (ticket-level grants) or
  a new status (its locks) can change both, so the view takes them from each answer and never
  keeps what an earlier read said, with no second read.

## Options considered

| Option | For | Against |
|---|---|---|
| Field editors in field rules (chosen) | One place for what a type's fields require; per type; already scoped shared or local | A rule set change is needed to restrict one field |
| A separate field security scheme | Mirrors Jira apps that add it | Another configuration set to assign, resolve and explain |
| Field locks per status in the workflow | Locks a field only once approved | Doubles the workflow format; the status edit lock covers the common case |
| Refuse with only the permission name | Smaller answers | The UI could not say who may, which WF-007 (2) asks for |

## Consequences

- Every new write path must check the status lock and field rules; bulk operations (M1-021),
  comments (M1-018) and the ticket view (M1-051) use `statusGate`, `fieldLocks` and the
  listing.
- An edit reads two more rows (the track's workflow version) before its transaction; the
  definition itself is cached.
- Revisit if people need a field locked only in some statuses; the workflow's per-status lists
  would then grow a `fields` entry.

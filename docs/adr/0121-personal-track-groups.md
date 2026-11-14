# ADR-121: Personal track groups, and the access a shared group gives

- Status: Accepted
- Date: 2026-11-03
- Backlog: M1-120 (tickets T-084 to T-087 in `docs/plan/tickets.md`)

## Context

The user asked on 2026-11-03 for groups of tracks on the Tracks page: a person drags tracks
together into a group and names it (T-084); an open group is a glass bubble holding its tracks,
and a minimized one is the size of one track card, with a count and small glass squares for its
tracks (T-085); the owner can share a whole group with another person, or set it on another
person (T-086); and sharing a group gives access to its tracks (T-087).

Claude recommended groups that only organize. The user decided otherwise (`decisions.csv`,
"Personal track groups and access"): groups are private to their owner until shared, and sharing
a group gives access to its tracks, with three rules: the sharer picks a role; only tracks on
which the sharer may give that role are included; taking the share back removes only what the
share gave, never a role the person had otherwise.

Requirements: CORE-034 (groups) and IAM-034 (sharing them). No competing product, its
documentation or its screens were opened for this (ADR-003). The look uses our own glass tokens
and surfaces (ADR-114) and nothing else.

## Decision

### Groups (CORE-034)

- A group belongs to one person, holds tracks in an order, and has a name of 1 to 100
  characters. **A track sits in at most one of a person's groups**: moving it into another takes
  it out of the first, and a group made from a track in another group takes it from there.
  A group may be empty.
- The arrangement is the person's and lives on the server (migration 0100): the order of their
  groups and of the groups shared with them, which are minimized, and the order of the tracks in
  each. Tracks in no group follow, in the directory's order.
- A group shows only the tracks the person sees in the track list. A track they lose sight of
  stays in the group, unseen, and comes back if they see it again; nothing about it is shown.
  A place given for a move counts the tracks the person sees, as the page shows them, so unseen
  tracks never shift a move.
- Searching the Tracks page shows the plain list of matches, as before.

### On the page (T-085)

- An open group is a glass bubble across the page's width holding its tracks as cards. A
  minimized group takes the place of one track card: its name, how many tracks it holds, and a
  small glass square for each of the first nine, with the track's initial. Opening it is one
  press.
- Everything a drag does has a keyboard path and a touch path. Drags use pointer events from a
  handle on each card and each group (mouse and touch alike; the handle keeps the page from
  scrolling under a finger). Each card and group also has a menu with the same moves, and the
  handles move with Alt and the arrow keys, as board cards do:
  - a track dropped on a track in no group makes a new group of the two, named in a dialog
    (the track's menu: "New group with this track");
  - a track dropped on a group, or on a track in it, goes into that group at that place (the
    menu lists the groups by name; Alt+Up and Alt+Down move it within its group);
  - a track dropped on the space of tracks in no group leaves its group (menu: "Take out of" and the group);
  - a group dropped on another group takes its place in the order (menu: "Move earlier",
    "Move later"; Alt+Up and Alt+Down on its handle).

### Sharing (IAM-034, T-086 and T-087)

- **Share** shows the group on the other person's page as the owner keeps it: name and tracks
  follow the owner's changes. The person may minimize it and put it in their own order, nothing
  more. Only the owner shares, changes the role (by taking the share back and sharing again)
  and takes it back.
- **The sharer picks a role**, or none. With a role, the share gives it on each of the group's
  tracks where the sharer may give it on that track's People page: they run the track
  (`administer_track`), and a role that runs the track also needs `appoint_track_admins`
  (IAM-028). Elsewhere it gives nothing, and the answer says on how many tracks it gave, on how
  many the person already had it, and on how many the sharer may not give it. With no role the
  group is only shown, and the person sees the tracks they could already see.
- The role is an **ordinary role in the track** (a `track_role_actor` row), so the authorizer,
  the People page, invitations and the audit log treat it like any other, and nothing in the
  permission check changes. `track_group_access` records which shares hold each such role:
  - a role the person lacks is added, and the share holds it;
  - a role other shares hold is held by this share too, and stays while any of them does;
  - a role the person had otherwise is left alone: no share holds it.
- **Live with the group.** A track moved into a shared group brings each share's role, where the
  owner may give it at the time; a track moved out takes back what the shares held there.
  Deleting a shared group takes back everything its shares held.
- **Taking a share back removes only what shares gave.** A role still held by another share
  stays. A role given on the People page, by an invitation or by an import, after a share gave
  it becomes the person's own: the shares stop holding it, and the change's event says so with
  `keptFromGroupShares` (`track_role.actor_added` on the People page and for an invitation by
  name, `track_invitation.created`, `.resent` or `.accepted` otherwise). A role removed on the
  People page or by revoking an invitation leaves no record behind.
- **One change at a time.** A change to a person's groups takes an advisory lock on that
  person's arrangement and a row lock on the group before it reads anything, and every write of
  a person's role in a track (shares, the People page, invitations, imports) first locks the
  track row. A give, a take-back and a role made the person's own therefore never interleave,
  and a share's record never outlives or misses the role it stands for. Sharing a group with
  someone, or setting one on them, also takes that person's arrangement lock and checks under it
  that they are still active. Locks start in one order everywhere: arrangements (in id order),
  then the group, then tracks. The share and copy routes write their row that names the person
  before they lock tracks; an erasure is still safe against them because both take the person's
  arrangement lock first. The track locks matter for the writers that take no arrangement lock
  (the People page, invitations, imports), which lock the track before they write a role.
- **Never the last one to run a track.** If taking back would leave a track with nobody to run it
  (IAM-028's rule for the People page), the change is refused with `last_track_admin` and the
  tracks, and nothing changes.
- **The permission to create tracks goes with the last role** (T-087b; ADR-118). Every take-back
  (a share taken back, a group left or deleted, a track moved out of a shared group, an erasure)
  runs through `releaseShares`, which removes the create-tracks grant that came with a role from
  anyone the roles it removed leave running no track. The change's one event lists it as
  `createTracksGrantsRemoved` (`track_group.unshared`, `.left`, `.deleted`, `.created` when it
  takes tracks out of other groups, `.track_moved`, and `user.erased`).
- **People.** A group goes only to an active person of the workspace other than its owner;
  a deactivated person is refused (`person_inactive`) and gets nothing. A share made before
  someone was deactivated stays, shows them as inactive, and can be taken back as usual. The
  picker needs "Browse users", as mentioning people does.
- **The sharer's rights are checked when the role is given, not later.** If the owner later stops
  running a track, what a share gave there stays, as a role they gave on the People page would.
  A token without the admin scope gives only what its owner could give without administrator
  rights (IAM-007).

### Setting a group on someone (T-086)

"Set it on another person" is read as **giving them a group of their own**: a copy with the same
name and tracks, in their arrangement, marked with who gave it. It is theirs from then on: they
rename it, move tracks and delete it, and neither side's later changes reach the other. Tracks
they already keep in one of their groups stay where they put them. A role, if chosen, is given by
the same rule as a share, but **as an ordinary role, held by no share**: deleting either group
takes nothing, and a track's administrators remove it on its People page. A role the person
held only through shares becomes theirs too, and `track_group.copied` lists it as `kept`. This is a reading the
user has not confirmed; changing it touches only `POST /api/v1/track-groups/:id/copies`.

### Leaving a group shared with you (T-204)

- The person a group is shared with may leave it (`POST /api/v1/track-groups/:id/leave`). The
  share goes, and what it held goes exactly as when the owner takes it back: only roles no other
  share holds, never a role the person had otherwise, and never the last one to run a track
  (`409 last_track_admin` with the tracks, and nothing changes). The change takes the owner's
  and the leaver's arrangement locks and the group's row, as the owner's changes do. One's own
  group is deleted, not left (`403`).
- One event, `track_group.left`, with the owner's group as subject, the owner (`ownerId`), the
  role and the roles that went (`removed`). It is audited, so the trail of the owner's group
  says who left and what went.
- A group shared with the person carries `holds`: on how many of the tracks it shows them its
  role is theirs through this share alone, which is what leaving takes (a track they may not see
  is never counted, as it is never shown). The page asks first and says which role goes from how
  many tracks. It reads its track list again before the change shows, since tracks the share
  opened go with it, so focus lands on a group or track still there; when no track is left, the
  page's empty state takes focus and the page says the group was left.

### A person's data and erasure (T-205; ADR-111)

- The data download has `track-groups.json`: the groups the person owns (name, when, minimized,
  who set a copy on them, tracks by key, and whom each is shared with and the role) and those
  shared with them (name, owner, role, when, tracks by key and the roles the share gave). A
  download the person asked for lists only the tracks they see in the track list now, as their
  page does; a site administrator's lists every track.
- Erasure removes the person's groups and the shares they received, after the person is
  deactivated in the erasure's transaction, so they no longer count as running a track. What
  their groups' shares gave others is taken back by the rules above, except a role that is the
  last way to run its track: **the erasure goes through and that person keeps the role** (T-205a,
  the user's decision of 2026-11-13, replacing the first build's `409 last_track_admin`). The
  share's record goes with the share, so the role is the person's own from then on, as a role
  given on the People page is (`releaseShares` with `keepLast`); taking it away later is the People
  page's ordinary rule, which keeps the last one to run a track. An erasure request is never held
  up by someone else's role. What the shares they received gave them goes without that check:
  once deactivated their roles run nothing. Copies they set on others stay, as the others' own;
  `user.erased` lists the roles that went (`groupAccess`) and the roles that stayed with their
  holders (`groupAccessKept`), and `POST /users/:id/erase` no longer answers `last_track_admin`.
- The erasure takes the routes' locks in the routes' order before it locks the person's account
  row: the arrangements of the person and of everyone whose group they received, then the tracks
  those shares and the shares of their groups hold roles on. Someone who shared with the person
  while the erasure read who had starts the arrangement locks again from a savepoint, so they stay
  in id order. A share or copy waiting on the person's lock finds them deactivated and is refused
  (`person_inactive`), so nothing reaches an erased account.

### Telling the person (T-206)

- A share and a copy tell the person they reach, as the product event `track_group_shared`
  (outside notification policies, like a mention): an inbox item, and an email as their
  preferences say (the event's two boxes, and their email delivery). Nobody else hears of it.
- The item names the group by its name now, who shared it, how (shared, or set on them as a copy)
  and the role if one came with it. It never names a track, so it shows nothing the person may
  not see. It shows, and its email goes, only while the group is still theirs: taken back, left
  or deleted, it goes. It is not a direct ask; the Priority tab stays mentions and assignments.

### Events, audit and tokens

- One event per change, `track_group.*`, with ids and names only and the roles a change gave or
  took (`given`, `removed`), and any create-tracks grants that went with them
  (`createTracksGrantsRemoved`, above). The audit log records those that can change access (`created`,
  `deleted`, `track_moved`, `shared`, `unshared`, `left`, `copied`); renaming, minimizing and ordering
  are a person's own arrangement and are not audited.
- Every route is read for GET and write otherwise. Sharing gives roles, as the People page does
  with a write token; the per-track check above still applies.

## Options considered

| Option | For | Against |
|---|---|---|
| Groups that only organize (recommended by Claude) | Nothing about access changes; simplest | Not what the user decided |
| A share as a new kind of grant in the authorizer | Taking back is just deleting the share | Every permission check grows; the People page would not show who has access through a group |
| **Ordinary role rows, with a record of which shares hold them** (chosen) | The authorizer is untouched; administrators see and can remove the role; taking back is exact | Changes to roles elsewhere must keep the record right (the People page and invitations do) |
| Access fixed at the moment of sharing | Moving tracks never changes access | A track added to a shared group would show to the person but not open |
| "Set on" as the same live group the person cannot remove | One kind of share | Hard to tell apart from sharing; a person could not arrange it |

## Consequences

- A group becomes a way to grant a role on many tracks at once, bounded by what the sharer could
  grant track by track; the audit log shows each role that came and went.
- Any new way of giving or removing a person's track role must lock the track (`lockTracks`)
  and call `keepRole` (both in `apps/server/src/trackgroups/access.ts`) so the shares' record
  stays exact.
- Revisit if the user wants "set on" to mean something else, or wants a share to follow later
  changes in the sharer's rights. Leaving a shared group (T-204), the data download and erasure
  (T-205) and telling the person (T-206) were added on 2026-11-03, in the sections above.

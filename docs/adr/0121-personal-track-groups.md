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
  and a share's record never outlives or misses the role it stands for.
- **Never the last one to run a track.** If taking back would leave a track with nobody to run it
  (IAM-028's rule for the People page), the change is refused with `last_track_admin` and the
  tracks, and nothing changes.
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

### Events, audit and tokens

- One event per change, `track_group.*`, with ids and names only and the roles a change gave or
  took (`given`, `removed`). The audit log records those that can change access (`created`,
  `deleted`, `track_moved`, `shared`, `unshared`, `copied`); renaming, minimizing and ordering
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
- Revisit if the user wants "set on" to mean something else, wants a person to leave a group
  shared with them, or wants a share to follow later changes in the sharer's rights.

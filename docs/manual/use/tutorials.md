---
title: "Tutorials"
audience: users
sources: apps/web/src/tutorial/sections.ts, apps/web/src/tutorial/steps.ts, apps/web/src/tutorial/TutorialProvider.tsx, apps/web/src/tutorial/CoachCard.tsx, apps/web/src/tutorial/FirstRunOffer.tsx, apps/web/src/tutorial/TutorialsPage.tsx, apps/web/src/tutorial/TutorialPicker.tsx, apps/web/src/tutorial/client.ts, apps/web/src/api/changes.ts, apps/web/src/i18n/messages.en.ts, apps/web/src/styles/surfaces.css, apps/web/src/shell/ModalDialog.tsx, apps/server/src/routes/tutorial.ts, packages/db/src/migrations/0084_tutorial_progress.ts, docs/adr/0115-guided-tutorial.md, docs/specs/01b-core-work-tracking.md
accessed: 2026-11-04
attestation: own-words
---
# Tutorials

The guided tutorial teaches Taskmoor by having you use it. It is split into sections, and each
section walks you through making one real thing in this instance: a ticket, a dashboard, a
sprint. What you make is real and stays, so at the end you can keep it or delete it. Your place
in every section is saved with your account, so it follows you to another device.

## The sections

| Section | What you make | Offered to |
|---|---|---|
| **Tracks and tickets** | A track (if you may make one), a ticket in it, a comment and an attached file | Everyone |
| **Workflows** | A workflow that moves freely, with a status added, published, put in a workflow map and given to a track | Site and configuration administrators |
| **Boards and sprints** | A card moved on a track's board, then a sprint planned and started in the backlog | Everyone |
| **Search and saved searches** | A search with filters, then a query, saved under a name | Everyone |
| **Dashboards** | A dashboard with a widget | Everyone |
| **Releases** | A release with a ticket aimed at it, marked shipped | Everyone |
| **Administration** | A person, a group with that person in it, and a role in a track for the group | Site administrators |
| **Import** | Tickets brought in from a CSV file, after a dry run | Site administrators |

You only see the sections you may do. If you cannot make tracks, **Tracks and tickets** asks you to
open one of yours instead. The server still decides every change: a step you are not allowed to
do shows the usual refusal, and you can choose **Next** to go past it.

## The first time you sign in

At the top of **Home**, a welcome panel offers the sections as cards to tick. **Tracks and
tickets**, **Boards and sprints** and **Search and saved searches** are ticked to begin with.
The panel sits in the page, so the rest of Home works as usual around it.

| Choice | What happens |
|---|---|
| **Start** | Starts the ticked sections, one after another |
| **Not now** | Closes the offer |
| **Don't offer again** | Closes the offer and records that you do not want it |

Whichever you choose, the offer does not come back on its own, and every section stays in
**Settings, Tutorials**. The offer is also left out if you already started a section there.

## Settings, Tutorials

**Settings, Tutorials** (also in the **Help** menu, and **Take the tour** on Home) lists every
section you may take with its state: **Not started**, **In progress**, **Done** or **Skipped**.
Each card has its own button:

- **Start** begins the section at its first step.
- **Resume** goes back to the step where you left it, on any device.
- **Do it again** replays a finished section from the start.

Tick several sections and choose **Start N sections** to take them in a row. Sections not done
yet are ticked when the page opens.

## Taking a section

A card floats at the bottom corner of the window. It shows the section and the step (**Step 3
of 6**), what to do and why it matters. The control to use has a ring around it and the rest of
the page is dimmed, but everything stays usable: you can click anywhere, and the card moves to
the other corner if it would cover the control. On a phone the card sits across the bottom of
the screen. The page, and a dialog open over it such as the create dialog or a ticket, leave
room at the end, so you can scroll what the card covers into view above it.

Steps that ask you to do something wait for you. Do it your own way, from any page; once the
server has it (the ticket made, the dashboard saved) the card moves on by itself. A step that
happens on another page shows **Take me there**.

| Control | What it does |
|---|---|
| **Back** | Shows the step before again; it then waits for **Next**, even after you do what it asks |
| **Next** | Goes on, also past a step you did differently or want to skip; on the last step it is **Finish** |
| **Pause** | Hides the card and keeps your place |
| **Skip section** | Marks the section skipped and starts the next one you picked, if any |
| Escape | Pauses, like **Pause**, wherever you are, except in a field, a menu or another dialog, which use Escape themselves |

While paused, a small panel at the bottom corner (across the bottom of a phone, with the same
room kept) says where you are, with **Resume** and **Close for now**. Closing
keeps the section in progress, to resume from Settings, Tutorials. A reload of the page keeps the
card where it was in that browser tab; another tab or device starts nothing until you resume.

The last step of each section offers **Open what you made**, the page where you can keep working
on it or delete it.

## Keyboard and screen readers

The card is a dialog that does not block the page. When a section starts, and after **Back**,
**Next** and **Resume**, focus moves to the card, so a screen reader reads the step. When a step
moves on by itself while you are typing or working in another dialog, focus stays where it is
and the new step is announced instead. Tab leaves the card for the page as usual; nothing holds
focus. Pausing or finishing puts focus back where it was before the card took it.

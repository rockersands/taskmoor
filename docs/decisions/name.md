# Public name screening

Task M0-007. "Tracksmith" was the working codename. **On 2026-10-12 the user chose taskmoor**
(written Taskmoor at the start of a sentence and in titles) from the shortlist below. This file
records what was checked and what remains for a lawyer.

## Method

For each candidate, on 2026-10-12:

1. **npm**: is the package name taken? (`npm view <name>`)
2. **.com**: does `<name>.com` resolve? Unresolved usually means available, but a registered
   domain without DNS looks the same, so the registrar must confirm.
3. **GitHub**: does a user or organisation with that name exist, and how many repositories are
   named exactly that?
4. **Web**: does a product, company or project use the name?
5. **Trademarks**: USPTO records found through public mirrors. EUIPO and WIPO were not searched
   yet; a lawyer's clearance search covers them.

## Tracksmith (codename)

- Tracksmith Corporation (Boston) holds several US registrations for TRACKSMITH: standard
  character marks registered 2015, 2016 and 2023, plus design marks, in classes 18 (bags),
  24 (towels, blankets), 25 (clothing, footwear), 35 (retail) and 41 (running events and
  education). No registration in classes 9 (software) or 42 (software services) was found.
- `tracksmith` is taken on npm, GitHub (organisation) and tracksmith.com.
- Verdict: usable as an internal codename, not as the public name. A different class is not a
  safe harbour against a well-known brand, and the handles are gone.

## Candidates

Free on npm, .com unresolved, GitHub user free, no product found on the web:

| Name | npm | .com | GitHub user | Repos named | Web | Notes |
|---|---|---|---|---|---|---|
| **issuetide** | free | unresolved | free | 0 | nothing | Reads as "issue tide"; distinctive |
| **workrill** | free | unresolved | free | 0 | nothing | Near "Workrave", "Workr", "Workgrid" (other products) |
| **taskmoor** | free | unresolved | free | 1 | nothing | Near "Taskmo" (an AI task app) |

Checked and set aside:

| Name | Why not |
|---|---|
| kanbard | Collides with Kanboard, an existing open-source Kanban tool |
| itemflow, worktrail, taskvault, sprintwell, workledger, lanekeeper, workforge, backlogic, ledgerbox, gridstone | GitHub organisation or several repositories already use the name, or .com is taken |
| milestoner, backlogger, issuary | npm package exists |
| ticketloom, trackvale, boardwright, tallyard, ticketwright, boardlane | .com taken |

## Decision

The user chose **taskmoor** on 2026-10-12. Checked again that day: the npm name and the GitHub
user are still free. Still to do before the first public release: register the .com and the
GitHub organisation, and counsel's knock-out search (USPTO, EUIPO, WIPO; classes 9 and 42),
which the user moved to the counsel review before release.

## Recommendation (before the choice)

Shortlist **issuetide** first, then **workrill** and **taskmoor**. Before choosing: register
the .com and the GitHub organisation, run a USPTO/EUIPO/WIPO knock-out search (class 9 and
42), and have counsel confirm. The repository, packages (`@tracksmith/*`) and image names are
renamed in one commit once the name is settled; nothing public uses the codename.

Sources: USPTO records via [Justia](https://trademark.justia.com/862/60/tracksmith-86260165.html)
and [GleanMark](https://gleanmark.com/owner/tracksmithcorp); the company's own site
[tracksmith.com](https://tracksmith.com/pages/about).

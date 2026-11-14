# T-359 hand-over: the third sweep's fixes, stopped mid-wave (2026-11-14, the Mac)

The user asked to wrap up while the six fix groups were running. The work is saved on six pushed
branches, none merged to `main`, none through the full gate. Each branch starts from `fc5d4e41`.

| Branch | Tip | State | What is left |
|---|---|---|---|
| `wave26m/t359-admin2` (System status, account, settings, admin m to z) | `81bebda7` | Built, reviewed, fixed, re-checked: ready to merge | Nothing in review; see the notes below for follow-ups |
| `wave26m/t359-statistics` | `e11e96bf` | Built; review stopped before it finished | Review, fix, re-check |
| `wave26m/t359-states` (stand-alone pages, pop-up, print) | `ab268e29` | Built; review stopped before it finished | Review, fix, re-check |
| `wave26m/t359-work` (help marks, bulk link, your work) | `d8e877d9` | The build was stopped while its tests ran: 8 commits, the builder's report never came | Check the branch against its section (S3-WK and S3-AC-8), run its tests, then review |
| `wave26m/t359-track` | `905cd2d5` | Built and reviewed; the fix round was stopped: its last commit is work in progress, untested | Finish the fix round (TR-8, the kanban phone page height, S3-TR-9's breadcrumb), test, re-check |
| `wave26m/t359-admin1` | `e8bf2495` | Built and reviewed; the fix round was stopped: its last commit is work in progress, untested | Finish the fix round (AD-9's SSO address on phones, a time-zone-safe audit test, `audit.syslog_test` words, the layout preview's custom release and area rows), test, re-check |

To finish: for each branch, run the review and fix rounds as in the earlier waves; then merge all
six on an integration branch from `origin/main`, take the main lock in `COORDINATION.md`, run the
full `pnpm verify --e2e`, fast-forward `main`, free the lock, and mark T-359 Done in `tickets.md`.

## The builders' and reviewers' notes

### build:t359-admin2
sha ce38e0bb
NOTDONE: Not done:
- S3-AC-8 (the help mark on Settings and Account) was left to the work group, as asked.
- The earlier faults marked 'Not pictured' (the sticky admin side list, AC-19, AC-20, AC-1) were not reworked: the sweep cannot show them.
- I did not run the whole gate (pnpm verify --e2e), only the targeted runs.

Left as built, for you to judge:
- The workflow editor still has 'Add a status' with 'Add to workflow'. It adds an existing site-wide status to the workflow from a list rather than creating one, so 'New status' would be wrong there. If it should still look like the New buttons, that is a wording decision for you.
- The sweep's 'Sweep draft' workflow keeps its name, because the sweep's routes find it by that name. Only its description changed.
- The new card-heading rule (S3-AC-7) is in shared CSS, so it also applies to AI limits and Configuration sets. Those pages are not in my section. In a narrow card their New buttons also go under the heading now.

Follow-ups (new ticket numbers, not added to tickets.md):
- T-360: the upgrade command (apps/server/src/upgrade.ts, around line 442) still says 'no backup directory: set TASKMOOR_DATA or TASKMOOR_BACKUP_DIR' when TASKMOOR_BACKUP_DIR=off. It should give the same reason the backups now give.
- T-361: the restore drill job is not declined by a worker without a backup directory. A drill on a host that cannot see the backup's folder could fail. Hosts that do not share storage need a decision.
- T-362: the Latest alerts list still says '{count} in {minutes} minutes'. That string is shared with the Administration overview, so a change there needs whoever owns that page.
- T-363: in account--375--dark, the Profile tab shows the language 'Spanish' while the page is in English. It may come from the sweep's order of captures; I did not look into it.

Notes:
- The worker reports are internal housekeeping (two instance_setting keys written every 5 minutes), not a person's change. They have no event or audit record, and I did not write an ADR.
- No migration, no API change in the OpenAPI goldens (the backup endpoints are not in them), no push and no merge.
### review:t359-admin2
ok False
 - medium apps/server/src/backups/runs.ts 149 {'file': 'apps/server/src/backups/runs.ts', 'line': 149, 'severity': 'medium', 'summary': "The S3-AC-1 failure that the sweep pictured still gives the wrong cause. runView labels every older failure that starts with 'this worker has no backup directory' as reason 'no-directory', and the page then says the worker 'had no place to keep backups'. Before this branch that one message was written for both TASKMOOR_BACKUP_DIR=off and a missing directory. With this branch no new failure of this kind is recorded, because workers decline the job. So every such failure an operator will ever see is an old
### build:t359-track
sha 68e0004a3bbcc3ac770524f68ab0068eaa0e22ca
NOTDONE: Not fixed. Each needs a design call, and I added no ticket numbers for them:

1. TR-8 (track list Summary column about 240 px): not changed. The other columns are already at their minimum widths: names and dates on one line and pencils kept 32 px from the next column (both from earlier TR-8 fixes and checked by the FitsTheCardAt1280 story), and the icon-only Type column. The Summary column can only get wider if dates wrap, a default column goes, or the table scrolls sideways. Suggested ticket T-360: choose one (for example, date-only Updated on the track list).

2. Kanban board on a phone (changed): the page is still as tall as the longest column, so scrolling down a short column shows empty canvas. Fixing it needs a new phone layout, such as each column scrolling on its own or a picker that shows one column at a time. Either changes drag and drop and its auto-scroll. Suggested ticket T-361.

3. S3-TR-9, the breadcrumb on a phone: this part is not done. Line one still ends with a '›' and 'SWEEPL' wraps alone. The second line is 48 css lower because of the 44 px touch targets. AD-14 deliberately keeps each separator with the step before it, so a wrapped line never starts with '›'. The breadcrumb (AdminLayout and admin.css) is shared by every Administration page, which the two Administration groups own. Changing it (for example, a single '‹ Tracks you run' back link on phones) is a design decision for all of them. Suggested ticket T-362.

4. Design choice to confirm: S3-TR-11 is solved by making Complete sprint quiet on both tabs. The other choice is to make both primary.

5. Design choice to confirm: S3-TR-3 now shows the subticket icon in the key column instead of the words '0/1 subtickets closed', which PL-31 had added. The words are still the screen-reader name, the tooltip and the phone row's text.

6. For the coordinator:
- I edited shared files: App.tsx (one route line), dashboards.css (.track-numbers rules only), admin pages LayoutEditorPage and ConfigurationSetsPage, and five e2e specs (create-tracks, invitations, checklist-notices, layouts-track-admin, ticket-templates).
- Removed message keys: trackPeople.title, trackPeople.backToList, layouts.trackNoSets and admin.sets.trackNoRuleSets.
- Added message keys: layouts.noOwnSet, layouts.noOwnSetBody, admin.sets.noOwnRuleSet, admin.sets.noOwnRuleSetBody and boards.notFound.
- There is no migration, no server change and no OpenAPI change. I did not run the full `pnpm verify --e2e`.
### fix:t359-admin2:1
sha 81bebda7a49a08675cdcd1cbbd64cd304a5e16fd
NOTDONE: ['The Last failure line stays red until a backup succeeds. That happens for any unrecovered failure, and the Next backup warning above it already says why none will run, so I left the colour rule as it is. If the user wants failures shown neutrally while no worker can take backups, that is a product call; a possible follow-up is T-360.']
### review:t359-track
ok False
 - low apps/web/src/styles/search.css 252 {'file': 'apps/web/src/styles/search.css', 'line': 252, 'severity': 'low', 'summary': 'TR-8 is marked Changed in the sweep and left unfixed. No user decision covers it; the builder suggests a new ticket, T-360.', 'scenario': "On track-list at 1280 px the Summary column is still about 240 px wide, and MOB-52 wraps to 4 lines. The sweep notes that Type, Status and Assignee still have spare space. The task says to fix every Still there or Changed fault unless it waits on a decision named in decisions.csv or tickets.md. No such decision exists, so this needs either a fix or the coordinator's expli
 - low apps/web/src/styles/boards.css None {'file': 'apps/web/src/styles/boards.css', 'severity': 'low', 'summary': "The second sweep's 'Kanban columns on a phone' fault is marked Changed and left unfixed. No user decision covers it; the builder suggests T-361.", 'scenario': 'On track-kanban-board at 375 px the page is still 4488 css px tall, as tall as the longest column. Scrolling down a short column shows about a window and a half of empty canvas (sweep pictures --6 and --7). The task asked for every Changed fault in the section to be fixed unless a user decision blocks it, and none does.'}
 - low apps/web/src/styles/admin.css 218 {'file': 'apps/web/src/styles/admin.css', 'line': 218, 'severity': 'low', 'summary': "S3-TR-9 is only partly fixed: the phone breadcrumb on the track's own pages still has the second line about 48 css px below the first.", 'scenario': "Open manage-track-layouts or manage-track-configuration-sets at 375 px. The breadcrumb wraps, and 'SWEEPL' sits alone about 48 css px under line one because the links are 44 px touch targets. The dangling '›' at the end of line one is AD-14's deliberate behaviour, so that part is fine. The large row gap is not covered by any decision. The builder deferred it as 
### recheck:t359-admin2:1
ok True
### build:t359-admin1
sha d654971b
NOTDONE: AD-9 (Still there) is not fixed: the SSO redirect address still breaks inside 'v1' on a phone. The address is in a read-only textarea, and Chromium does not break a line after '/' on its own. I tried removing `word-break: break-all`, and a story measuring where the lines break showed breaks after 'a' and 'c' instead, so I took the change out. A real fix means swapping the textarea for a text block with `<wbr>` (BreakAtSlashes) that can still be focused and selected. That changes its role and value, so IdentityProvidersPage.test.tsx and setup.spec.ts:904 (which use toHaveValue on a textbox) would need changing too. Suggested follow-up: T-360.

Not pictured in the sweep, so I left them alone: AD-23 (the type set form's checkboxes) and whether the side list stays in place while scrolling. The source already makes it sticky.

Other follow-ups:
- T-361: 'Bulk change 1' stays named by its id, because bulk changes have no name. Another kind of subject that should be named instead would need its table added to the server's list of named subjects (NAMED_SUBJECTS in apps/server/src/routes/audit.ts).
- T-362: the layout preview only says that releases and areas depend on the track; with a track chosen it could read that track's releases and areas and leave those rows out.
- T-363: AuditPage.test.tsx expects the time to match /\d:14:29/, which assumes a test time zone with a whole-hour offset.

Things to know when merging:
- The audit table's Address column is gone, and 'admin.audit.column.address' was removed from both catalogues.
- The new words.test.ts fails when Windows adds a new audited plan.* event without words in apps/web/src/admin/audit/words.ts and the admin.audit.verb.* messages.

Question for the user: are the 'Every page' card on the overview and the closed side-list groups there acceptable? The user's decision of 2026-11-13 (decisions.csv row 105) asked for collapsing groups but did not say how the overview should list pages.
### review:t359-admin1
ok False
 - medium apps/web/src/sso/IdentityProvidersPage.tsx None {'file': 'apps/web/src/sso/IdentityProvidersPage.tsx', 'severity': 'medium', 'summary': 'AD-9 is marked Still there in the section, and the branch does not fix it. The task requires fixing every Still there or Changed fault unless it waits on a user decision or sits in apps/web/src/plans. AD-9 meets neither condition: the builder deferred it because the fix is technically awkward (textarea vs BreakAtSlashes) and suggested a follow-up, T-360.', 'scenario': "On a 375 px phone, open Administration > Single sign-on. The redirect address still breaks inside 'v1' ('http://localhost:8090/api/v' / '1/
 - low apps/web/src/admin/audit/AuditPage.test.tsx 397 {'file': 'apps/web/src/admin/audit/AuditPage.test.tsx', 'line': 397, 'severity': 'low', 'summary': "The new test 'puts the day over the time…' expects the time cell to match /\\d:14:29/ for 2026-11-14T09:14:29Z. That only holds in a time zone with a whole-hour offset. The repo already has apps/web/src/test/timeZone.ts to pin the zone, and the test does not use it. The builder listed this as follow-up T-363, but the fragile test is new on this branch.", 'scenario': 'Run pnpm verify on a machine set to Asia/Kolkata (UTC+5:30) or America/St_Johns (UTC-3:30). The cell reads 2:44:29 PM or 5:44:29 A
 - low apps/web/src/admin/audit/words.test.ts 599 {'file': 'apps/web/src/admin/audit/words.test.ts', 'line': 599, 'severity': 'low', 'summary': "S3-AD-1 asked for a test that every action code the server can write has words. SERVER_ACTIONS reads only AUDITED_EVENTS, AUDIT_ACTIONS and REFUSALS_AUDIT_ACTION. It misses 'audit.syslog_test', which apps/server/src/routes/audit.ts:413 writes as a literal through appendAudit, so that code is not covered.", 'scenario': "Remove 'syslog_test' from AUDIT_VERBS in words.ts, or a new literal action is written beside it. words.test.ts still passes, and the audit page shows the raw 'audit.syslog_test' after 
 - low apps/web/src/layouts/LayoutPreview.tsx 56 {'file': 'apps/web/src/layouts/LayoutPreview.tsx', 'line': 56, 'severity': 'low', 'summary': "ONLY_WHEN_LISTED keys only the built-in fields targetRelease, foundInRelease and area. CreateTicketPage also drops optional custom fields of type 'release' or 'area' when the track has none (listKindOf → list?.length === 0 && !field.required). The preview still shows those custom rows with no hint, so the Changed fault 'the preview may still show rows the form leaves out' remains for them.", 'scenario': "An admin places an optional custom field of type release (say 'Shipped in') on a Create layout and
### build:t359-states
sha ab268e29
NOTDONE: Not done, or left to someone else:

1. Workflow-not-found's sidebar (Changed): I changed nothing. The original fault is gone: the app sidebar and the admin list now both mark nothing, as the not-found rule in PL-43 asks. What the sweep still describes is the breadcrumb "Administration › Tracks and setup › Workflows › Workflow not found" and the admin list left open at Tracks and setup. Question for the user: should a not-found page under Administration drop its breadcrumb and fold the list, or is the breadcrumb a welcome way back?
2. S3-SP-10: the board's Move menu now acts like the other grip menus for focus and keys, but it still opens inside the card rather than floating. That is on purpose: a long board column scrolls (the LongColumn story, T-193) and would cut off a floating menu. Question for the user: is a menu in the card acceptable, or should it float like the backlog's and the calendar's, which needs a way to get past the column's clipping?
3. Left to other groups (same "may not see" wording as S3-SP-7):
   - `boards.failed` belongs to S3-TR-10.
   - `bulk.reason.notFound` is in the work group's bulk page.
4. I also changed `instance.wrongAdmin` to "a site administrator" (English and Spanish). It is on the wrong-server stand-alone page, which the sweep did not picture; it is the same wording fault as S3-SP-6.
5. Follow-ups (new ticket numbers are proposals only; I did not edit tickets.md):
   - T-360: the clone dialog's track list still reads "KEY: Name" while the create form now reads "KEY · Name"; pick one form for both.
   - T-361: the printed page still shows faint glass edges round the Description, Details and Activity cards (visible in state-ticket-print--1280--light). Not a listed fault.
   - T-362: re-sweep the state routes to confirm AC-4 and AD-42 on new pictures; I did not run `pnpm sweep`.
6. Test gaps:
   - The Points placeholder colour on paper has no test of its own, since the ATT e2e track has no Points field. The new rule sits beside the date alignment, which is tested.
   - S3-SP-9 is checked on the 320-px story phone (the actions follow the status menu) and by the e2e runs on mobile. Nothing measures the row count at exactly 375 px.
7. Not run, per the rules: a full `pnpm verify` and `pnpm verify --e2e`; the coordinator's gate covers them.
### build:t359-statistics
sha e11e96bf
NOTDONE: Not done, or left on purpose:

1. **The reports' day against the calendar's 'today' (earlier fault): not pictured.** It can't be judged from a morning capture; it needs a sweep taken in the evening. I made no change.

2. **Checkbox sizes (earlier fault): no change.** On phones the 'Open tickets only' box is 28 css inside a 44 css label, and the whole label is the touch target. The backlog's boxes are now 28 css too, and the track sections group lists the pair as fixed. If you want 44 px boxes everywhere, that's a change to the shared checkbox style, which other groups also use.

3. **Areas I share with other groups.** I changed apps/web/src/dashboards/WidgetView.tsx, styles/dashboards.css and DashboardPage.test.tsx (the expected wording of the workload-pie empty state). The 'Your work' group may also be editing dashboards, so expect possible merge conflicts. The new ticket-list columns also apply to the search-results widget on dashboards.

4. **Proposed follow-ups:**
   - T-360: in the search, a bare number is read as a name before an id for releases, areas and teams. So if a release is literally named '5', a group's search for release id 5 would find that release instead. Fix: read a bare number as an id first, as cross-track releases already do.
   - T-361: a track-local ticket type with the same name as a shared one gets merged in the group's search, because types are searched by name.
   - T-362: the release burndown and release report pickers still open on the first release, even one that has shipped. Only release workload was in the fault list.
   - T-363: the grouped report lists its tickets most recently updated first, while the linked search uses the query's own order.

5. **Not run, as the rules require:** a full pnpm verify, pnpm verify --e2e, and pnpm verify --update. The other browser projects and the sweep were not rerun either.

6. **Housekeeping:** progress.csv, tickets.md, HANDOFF.md and COORDINATION.md are left for the coordinator. The embedded Postgres clusters in the worktree are stopped.

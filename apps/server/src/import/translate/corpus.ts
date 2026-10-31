/**
 * The translation corpus (M1-094; ADR-096): saved queries as people and scripts write them in a
 * Jira-compatible tracker, each with what Taskmoor's import must make of it. Written in our own
 * words from the query language's public description (spec 01b section 1, the dialect of
 * M1-035); the app functions and fields are invented, shaped like the ones apps add. The corpus
 * covers every field and function the dialect reads, names and ids of the source's objects,
 * history clauses, ORDER BY, and what cannot translate: apps' functions and fields, people and
 * projects the source does not have, syntax errors.
 *
 * Entries are written against a vocabulary of the source's objects (`Vocabulary`), so the same
 * corpus runs in the unit test (a fixed vocabulary) and in the synthetic backup, whose saved
 * filters use it with the generated instance's ids and names (`dc-backup/filters.ts`).
 */
export interface Vocabulary {
  project: { id: number; key: string; name: string };
  other: { id: number; key: string };
  status: { id: number; name: string };
  doneStatus: { id: number; name: string };
  priority: { id: number; name: string };
  resolution: { id: number; name: string };
  type: { id: number; name: string };
  person: { username: string; key: string };
  otherPerson: { username: string; key: string };
  group: string;
  role: string;
  /** Custom fields by kind, with an option or two where they have them. */
  number: { id: number; name: string };
  text: { id: number; name: string };
  date: { id: number; name: string };
  select: { id: number; name: string; option: { id: number; value: string } };
  multi: { id: number; name: string; option: { id: number; value: string } };
  cascade: {
    id: number;
    name: string;
    parent: { id: number; value: string };
    child: { id: number; value: string };
  };
  userField: { id: number; name: string };
  labelsField: { id: number; name: string };
  /** A field of an app's type: imported as read-only text. */
  appField: { id: number; name: string };
  /** An earlier saved filter, by id and name, its owner's own or shared with them. */
  filter: { id: number; name: string };
  sprint: { id: number; name: string };
  level: { id: number; name: string };
  issue: { id: number; key: string };
}

/** What the import makes of a query. */
export type Expectation =
  /** Translates, and runs. */
  | 'translated'
  /** Translates with a change (an ORDER BY term left out). */
  | 'changed'
  /** Translates, but names a module this version lacks: kept and flagged. */
  | 'flagged'
  /** Cannot translate: kept as written and flagged, with the reason and the name. */
  | 'untranslatable';

export interface CorpusEntry {
  id: string;
  /** What the entry is about, for the report and the golden. */
  title: string;
  query: (v: Vocabulary) => string;
  expect: Expectation;
  /** The problem's code, and its detail (a function or field name), when not translated. */
  reason?: (v: Vocabulary) => { code: string; detail?: string };
}

const q = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;

// biome-ignore format: one entry per line keeps the corpus readable
export const CORPUS: readonly CorpusEntry[] = [
  // --- Tracks, types, statuses: by key, name and id --------------------------------------
  { id: 'project-key', title: 'A project by key', query: (v) => `project = ${v.project.key}`, expect: 'translated' },
  { id: 'project-id', title: 'A project by id', query: (v) => `project = ${v.project.id}`, expect: 'translated' },
  { id: 'project-name', title: 'A project by name', query: (v) => `project = ${q(v.project.name)} AND status != ${q(v.doneStatus.name)}`, expect: 'translated' },
  { id: 'project-list', title: 'Projects in a list, mixed', query: (v) => `project in (${v.project.key}, ${v.other.id}) ORDER BY created DESC`, expect: 'translated' },
  { id: 'issuetype-id', title: 'A type by id', query: (v) => `issuetype = ${v.type.id}`, expect: 'translated' },
  { id: 'issuetype-name', title: 'Types by name and function', query: (v) => `issuetype in (${q(v.type.name)}) OR issuetype in subTaskIssueTypes()`, expect: 'translated' },
  { id: 'standard-types', title: 'Standard types', query: () => 'issuetype in standardIssueTypes()', expect: 'translated' },
  { id: 'status-id', title: 'A status by id', query: (v) => `status = ${v.status.id}`, expect: 'translated' },
  { id: 'status-names', title: 'Statuses by name', query: (v) => `status in (${q(v.status.name)}, ${q(v.doneStatus.name)})`, expect: 'translated' },
  { id: 'status-category', title: 'A status category by number and name', query: () => 'statusCategory = 3 OR statusCategory = "In Progress"', expect: 'translated' },
  { id: 'priority-id', title: 'A priority by id, ordered by priority', query: (v) => `priority = ${v.priority.id} ORDER BY priority DESC`, expect: 'translated' },
  { id: 'priority-order', title: 'Priorities above one', query: (v) => `priority >= ${q(v.priority.name)}`, expect: 'translated' },
  { id: 'resolution-id', title: 'A resolution by id', query: (v) => `resolution = ${v.resolution.id}`, expect: 'translated' },
  { id: 'unresolved', title: 'Unresolved work', query: () => 'resolution = Unresolved OR resolution is EMPTY', expect: 'translated' },
  { id: 'resolved-date', title: 'Resolved in the last week', query: () => 'resolved >= -1w AND resolutiondate <= now()', expect: 'translated' },
  { id: 'level-id', title: 'A security level by id', query: (v) => `level = ${v.level.id}`, expect: 'translated' },
  { id: 'level-name', title: 'A security level by name', query: (v) => `level in (${q(v.level.name)}) OR level is EMPTY`, expect: 'translated' },
  // --- People and groups -----------------------------------------------------------------
  { id: 'assignee-user', title: 'An assignee by user name', query: (v) => `assignee = ${v.person.username}`, expect: 'translated' },
  { id: 'assignee-key', title: 'An assignee by key', query: (v) => `assignee = ${q(v.person.key)}`, expect: 'translated' },
  { id: 'current-user', title: 'Mine, unresolved', query: () => 'assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC', expect: 'translated' },
  { id: 'reporter-in', title: 'Reporters in a list', query: (v) => `reporter in (${v.person.username}, ${v.otherPerson.username})`, expect: 'translated' },
  { id: 'reporter-group', title: 'Reporters in a group', query: (v) => `reporter in membersOf(${q(v.group)})`, expect: 'translated' },
  { id: 'creator', title: 'A creator', query: (v) => `creator = ${v.otherPerson.username}`, expect: 'translated' },
  { id: 'watcher', title: 'Watched by me, or watched', query: () => 'watcher = currentUser() OR issue in watchedIssues()', expect: 'translated' },
  { id: 'voter', title: 'Voted for', query: (v) => `voter = ${v.person.username} OR issue in votedIssues() ORDER BY votes DESC`, expect: 'translated' },
  { id: 'watchers-count', title: 'Many watchers', query: () => 'watchers > 2 ORDER BY watchers DESC', expect: 'translated' },
  { id: 'unassigned', title: 'Unassigned', query: () => 'assignee is EMPTY AND reporter is not EMPTY', expect: 'translated' },
  { id: 'unknown-user', title: 'A person the source does not have', query: () => 'assignee = nobody.here', expect: 'untranslatable', reason: () => ({ code: 'unknown_person', detail: 'nobody.here' }) },
  // --- Dates -----------------------------------------------------------------------------
  { id: 'created-relative', title: 'Created in the last two weeks', query: () => 'created >= -2w ORDER BY created ASC', expect: 'translated' },
  { id: 'updated-absolute', title: 'Updated since a date', query: () => 'updated > "2025-06-01" AND updated < "2025-07-01 12:00"', expect: 'translated' },
  { id: 'due-functions', title: 'Due this month', query: () => 'duedate >= startOfMonth() AND duedate <= endOfMonth()', expect: 'translated' },
  { id: 'date-increments', title: 'Date functions with increments', query: () => 'created > startOfWeek(-1w) AND created < endOfDay(-1d) OR updated > startOfYear() AND updated < endOfYear() OR created > startOfDay() AND created < endOfWeek()', expect: 'translated' },
  { id: 'logins', title: 'Since my last login', query: () => 'updated > lastLogin() OR created > currentLogin()', expect: 'translated' },
  // --- Text ------------------------------------------------------------------------------
  { id: 'summary-text', title: 'Words in the summary', query: () => 'summary ~ "export failed" AND description !~ "duplicate"', expect: 'translated' },
  { id: 'text-wildcard', title: 'Text with a wildcard', query: () => 'text ~ "invoic*" AND comment ~ "customer"', expect: 'translated' },
  { id: 'environment', title: 'Environment words', query: () => 'environment ~ "staging"', expect: 'translated' },
  // --- Labels, keys, links, parents --------------------------------------------------------
  { id: 'labels', title: 'Labels', query: () => 'labels in (urgent, "needs-review") AND labels is not EMPTY', expect: 'translated' },
  { id: 'key-list', title: 'Issues by key and id', query: (v) => `issuekey in (${v.issue.key}, ${v.issue.id})`, expect: 'translated' },
  { id: 'key-range', title: 'Keys after one (Taskmoor does not order keys)', query: (v) => `key > ${v.issue.key} ORDER BY key ASC`, expect: 'untranslatable', reason: () => ({ code: 'refused' }) },
  { id: 'parent', title: 'Children of an issue', query: (v) => `parent = ${v.issue.key}`, expect: 'translated' },
  { id: 'epic-link', title: 'An epic link', query: (v) => `"Epic Link" = ${v.issue.key}`, expect: 'translated' },
  { id: 'linked-issues', title: 'Issues linked to one', query: (v) => `issue in linkedIssues(${v.issue.key}, "blocks")`, expect: 'translated' },
  { id: 'issue-link-type', title: 'By link type', query: () => 'issueLinkType = "is blocked by"', expect: 'translated' },
  { id: 'remote-links', title: 'Issues with a remote link', query: () => 'issue in issuesWithRemoteLinksByGlobalId("app=docs&id=1")', expect: 'translated' },
  { id: 'issue-history', title: 'Recently viewed', query: () => 'issue in issueHistory() ORDER BY lastViewed DESC', expect: 'translated' },
  { id: 'attachments', title: 'With attachments', query: () => 'attachments is not EMPTY', expect: 'translated' },
  // --- Time tracking -----------------------------------------------------------------------
  { id: 'estimates', title: 'Estimates and time spent', query: () => 'originalEstimate > 3600 AND remainingEstimate > 0 AND timeSpent is EMPTY', expect: 'translated' },
  { id: 'work-ratio', title: 'Work ratio', query: () => 'workRatio > 75 ORDER BY workRatio DESC', expect: 'translated' },
  { id: 'worklog', title: 'Work log comments and dates', query: () => 'worklogComment ~ "deploy" AND worklogDate >= -30d', expect: 'translated' },
  // --- Projects by people ------------------------------------------------------------------
  { id: 'projects-lead', title: 'Projects I lead', query: () => 'project in projectsLeadByUser()', expect: 'translated' },
  { id: 'projects-lead-user', title: 'Projects another person leads', query: (v) => `project in projectsLeadByUser(${v.person.username})`, expect: 'translated' },
  { id: 'projects-permission', title: 'Projects where I may browse', query: () => 'project in projectsWhereUserHasPermission("Browse Projects")', expect: 'translated' },
  { id: 'projects-role', title: 'Projects where I have a role', query: (v) => `project in projectsWhereUserHasRole(${q(v.role)})`, expect: 'translated' },
  { id: 'components-lead', title: 'Components I lead', query: () => 'component in componentsLeadByUser()', expect: 'translated' },
  { id: 'updated-by', title: 'Updated by a person', query: (v) => `issue in updatedBy(${v.person.username}, "-30d")`, expect: 'translated' },
  // --- Releases and components by name (the fixture has none: they would be refused) ------
  { id: 'versions', title: 'Unreleased versions of a project', query: (v) => `fixVersion in unreleasedVersions(${v.project.key}) OR affectedVersion in releasedVersions()`, expect: 'translated' },
  { id: 'version-latest', title: 'Latest released version', query: (v) => `fixVersion = latestReleasedVersion(${v.project.key}) OR fixVersion = earliestUnreleasedVersion(${v.project.key})`, expect: 'translated' },
  // --- Sprints ------------------------------------------------------------------------------
  { id: 'open-sprints', title: 'Open sprints', query: () => 'sprint in openSprints() AND sprint not in futureSprints()', expect: 'translated' },
  { id: 'closed-sprints', title: 'Closed sprints', query: () => 'sprint in closedSprints()', expect: 'translated' },
  { id: 'sprint-name', title: 'A sprint by name', query: (v) => `sprint = ${q(v.sprint.name)}`, expect: 'translated' },
  { id: 'sprint-id', title: 'A sprint by id', query: (v) => `sprint = ${v.sprint.id}`, expect: 'translated' },
  // --- Custom fields by id and name --------------------------------------------------------
  { id: 'cf-number', title: 'A number field by id', query: (v) => `cf[${v.number.id}] > 3 ORDER BY cf[${v.number.id}] DESC`, expect: 'translated' },
  { id: 'cf-number-name', title: 'A number field by name', query: (v) => `${q(v.number.name)} >= 5 AND ${q(v.number.name)} is not EMPTY`, expect: 'translated' },
  { id: 'cf-text', title: 'A text field', query: (v) => `${q(v.text.name)} ~ "Acme"`, expect: 'translated' },
  { id: 'cf-date', title: 'A date field', query: (v) => `cf[${v.date.id}] <= endOfMonth(1M)`, expect: 'translated' },
  { id: 'cf-select-name', title: 'An option by value', query: (v) => `${q(v.select.name)} = ${q(v.select.option.value)}`, expect: 'translated' },
  { id: 'cf-select-id', title: 'An option by id', query: (v) => `cf[${v.select.id}] = ${v.select.option.id}`, expect: 'translated' },
  { id: 'cf-multi', title: 'Several options', query: (v) => `cf[${v.multi.id}] in (${v.multi.option.id}, ${q(v.multi.option.value)})`, expect: 'translated' },
  { id: 'cf-cascade', title: 'A cascading option by ids', query: (v) => `cf[${v.cascade.id}] in cascadeOption(${v.cascade.parent.id}, ${v.cascade.child.id})`, expect: 'translated' },
  { id: 'cf-cascade-name', title: 'A cascading option by names', query: (v) => `${q(v.cascade.name)} in cascadeOption(${q(v.cascade.parent.value)})`, expect: 'translated' },
  { id: 'cf-user', title: 'A person field', query: (v) => `cf[${v.userField.id}] = ${v.otherPerson.username} OR cf[${v.userField.id}] = currentUser()`, expect: 'translated' },
  { id: 'cf-labels', title: 'A labels field', query: (v) => `${q(v.labelsField.name)} in (exports)`, expect: 'translated' },
  { id: 'cf-empty', title: 'An empty custom field', query: (v) => `cf[${v.select.id}] is EMPTY`, expect: 'translated' },
  { id: 'cf-unknown-id', title: 'A custom field id the source does not have', query: () => 'cf[99999] = 1', expect: 'untranslatable', reason: () => ({ code: 'unknown_field', detail: 'cf[99999]' }) },
  { id: 'cf-app-compare', title: 'An app field compared like a number', query: (v) => `${q(v.appField.name)} > 3`, expect: 'untranslatable', reason: (v) => ({ code: 'refused', detail: v.appField.name }) },
  // --- History --------------------------------------------------------------------------------
  { id: 'status-was', title: 'A status it had', query: (v) => `status was ${q(v.status.name)} BY ${v.person.username} AFTER -30d`, expect: 'translated' },
  { id: 'status-was-id', title: 'A status it had, by id', query: (v) => `status was in (${v.status.id}, ${v.doneStatus.id}) DURING ("2025-01-01", "2025-12-31")`, expect: 'translated' },
  { id: 'status-changed', title: 'A status change', query: (v) => `status changed FROM ${v.status.id} TO ${q(v.doneStatus.name)} BY ${v.otherPerson.username} BEFORE now()`, expect: 'translated' },
  { id: 'assignee-was', title: 'An assignee it had', query: (v) => `assignee was not ${v.person.username} ON "2025-03-01"`, expect: 'translated' },
  { id: 'priority-changed', title: 'A priority change', query: () => 'priority changed AFTER startOfWeek()', expect: 'translated' },
  // --- Saved filters --------------------------------------------------------------------------
  { id: 'filter-id', title: 'Another filter by id', query: (v) => `filter = ${v.filter.id} AND resolution is EMPTY`, expect: 'translated' },
  { id: 'filter-name', title: 'Another filter by name', query: (v) => `filter = ${q(v.filter.name)} ORDER BY updated DESC`, expect: 'translated' },
  { id: 'filter-unknown', title: 'A filter the source does not have', query: () => 'filter = "No such filter"', expect: 'untranslatable', reason: () => ({ code: 'unknown_saved_search', detail: 'No such filter' }) },
  // --- ORDER BY ---------------------------------------------------------------------------------
  { id: 'board-filter', title: 'A board filter', query: (v) => `project = ${v.project.key} ORDER BY Rank ASC`, expect: 'changed' },
  { id: 'order-several', title: 'Several orderings', query: () => 'resolution is EMPTY ORDER BY priority DESC, updated ASC, key ASC', expect: 'translated' },
  { id: 'order-unknown', title: 'Ordering by an app field', query: (v) => `project = ${v.project.key} ORDER BY "Business Value" DESC, created DESC`, expect: 'changed' },
  // --- Grammar ----------------------------------------------------------------------------------
  { id: 'nested', title: 'Nested AND, OR and NOT', query: (v) => `(project = ${v.project.key} OR project = ${v.other.key}) AND NOT (status = ${q(v.doneStatus.name)} OR priority = ${v.priority.id})`, expect: 'translated' },
  { id: 'lower-case', title: 'Keywords in lower case', query: (v) => `project = ${v.project.key} and assignee != currentUser() or reporter is empty order by created desc`, expect: 'translated' },
  { id: 'not-in', title: 'NOT IN with ids', query: (v) => `status not in (${v.status.id}, ${v.doneStatus.id}) AND issuetype != ${v.type.id}`, expect: 'translated' },
  { id: 'empty-query', title: 'No condition, only an order', query: () => 'ORDER BY created DESC', expect: 'translated' },
  // --- Modules this version does not have ---------------------------------------------------------
  { id: 'service-sla', title: 'A service SLA', query: () => '"Time to resolution" = breached()', expect: 'untranslatable', reason: () => ({ code: 'unknown_field', detail: 'Time to resolution' }) },
  { id: 'service-approvals', title: 'Approvals waiting for me', query: () => 'approvals = myPendingApproval()', expect: 'flagged' },
  { id: 'service-organization', title: 'A customer organisation', query: () => 'organization = "Acme Corp"', expect: 'flagged' },
  // --- Apps' functions and fields, and broken text ----------------------------------------------------
  { id: 'app-subtasks', title: "An app's function over sub-tasks", query: (v) => `issueFunction in subtasksOf("project = ${v.project.key}")`, expect: 'untranslatable', reason: () => ({ code: 'unknown_field', detail: 'issueFunction' }) },
  { id: 'app-function', title: "An app's function on a known field", query: (v) => `issue in linkedIssuesOfAll(${q(`project = ${v.project.key}`)})`, expect: 'untranslatable', reason: () => ({ code: 'unknown_function', detail: 'linkedIssuesOfAll' }) },
  { id: 'app-epics', title: "An app's epic function", query: (v) => `issue in epicsOf("project = ${v.project.key}") AND status = ${v.status.id}`, expect: 'untranslatable', reason: () => ({ code: 'unknown_function', detail: 'epicsOf' }) },
  { id: 'app-team', title: "An app's team field", query: () => 'Team = 12 AND "Parent Link" = ABC-1', expect: 'untranslatable', reason: () => ({ code: 'unknown_field', detail: 'Team' }) },
  { id: 'app-portfolio', title: "An app's hierarchy function", query: (v) => `issue in portfolioChildIssuesOf(${v.issue.key})`, expect: 'untranslatable', reason: () => ({ code: 'unknown_function', detail: 'portfolioChildIssuesOf' }) },
  { id: 'unknown-project', title: 'A project the source does not have', query: () => 'project = NOPE', expect: 'untranslatable', reason: () => ({ code: 'unknown_project', detail: 'NOPE' }) },
  { id: 'syntax', title: 'Broken text', query: () => 'project = AND (status = Open', expect: 'untranslatable', reason: () => ({ code: 'syntax_error', detail: 'syntax' }) },
];

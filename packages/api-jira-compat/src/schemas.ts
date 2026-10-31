import { z } from 'zod';

/**
 * The bodies the Jira-compatible API answers with (M1-068; API-003 to API-006; ADR-016),
 * written in our own words from what public pages say about them (the sources of each
 * operation, in `operations.ts`). Objects are loose: a script reads the fields it knows, so the
 * contract names those and lets the rest vary. Ids that Jira writes as strings are strings here
 * too, and the Agile API's numeric ids are numbers.
 *
 * Version 2 of the API carries rich text as wiki markup (a string), version 3 as the
 * Jira-compatible document format (an object); `richText(version)` picks the shape.
 */
export const jiraError = z
  .object({
    errorMessages: z.array(z.string()),
    errors: z.record(z.string(), z.string()),
  })
  .loose()
  .meta({ id: 'JiraError', description: 'A refusal: messages, and problems by field name.' });

export const document = z
  .object({ type: z.literal('doc'), version: z.number(), content: z.array(z.unknown()) })
  .loose()
  .meta({ id: 'Document', description: 'Rich text in the Jira-compatible document format.' });

export const richText = (version: '2' | '3') =>
  version === '2' ? z.string().nullable() : document.nullable();

const id = z.string().meta({ description: 'An id, written as a string.' });
const instant = z.string().meta({ description: 'An instant, ISO 8601 with an offset.' });
const self = z.string().meta({ description: 'The address of the resource itself.' });

export const user = z
  .object({ accountId: z.string(), displayName: z.string(), active: z.boolean() })
  .loose()
  .meta({ id: 'User' });

export const statusCategory = z
  .object({ id: z.number(), key: z.string(), name: z.string() })
  .loose()
  .meta({ id: 'StatusCategory' });

export const status = z
  .object({ id, name: z.string(), statusCategory })
  .loose()
  .meta({ id: 'Status' });

export const issueType = z
  .object({ id, name: z.string(), subtask: z.boolean() })
  .loose()
  .meta({ id: 'IssueType' });

export const projectRef = z
  .object({ id, key: z.string(), name: z.string() })
  .loose()
  .meta({ id: 'ProjectRef' });

export const named = z.object({ id, name: z.string() }).loose();

export const issueFields = (version: '2' | '3') =>
  z
    .object({
      summary: z.string(),
      status,
      issuetype: issueType,
      project: projectRef,
      assignee: user.nullable(),
      reporter: user.nullable(),
      created: instant,
      updated: instant,
      labels: z.array(z.string()),
      description: richText(version).optional(),
    })
    .loose();

export const issue = (version: '2' | '3') =>
  z.object({ id, key: z.string(), self, fields: issueFields(version) }).loose();

export const createdIssue = z.object({ id, key: z.string(), self }).loose().meta({
  id: 'CreatedIssue',
});

export const transitions = z
  .object({ transitions: z.array(z.object({ id, name: z.string(), to: status }).loose()) })
  .loose();

export const comment = (version: '2' | '3') =>
  z
    .object({ id, author: user, body: richText(version), created: instant, updated: instant })
    .loose();

export const offsetPage = <T extends z.ZodType>(key: string, item: T) =>
  z
    .object({
      startAt: z.number(),
      maxResults: z.number(),
      total: z.number(),
      [key]: z.array(item),
    })
    .loose();

/** A page that says whether it is the last one, as the newer list operations do. */
export const valuesPage = <T extends z.ZodType>(item: T) =>
  z
    .object({
      startAt: z.number(),
      maxResults: z.number(),
      isLast: z.boolean(),
      values: z.array(item),
    })
    .loose();

export const worklog = z
  .object({ id, author: user, timeSpentSeconds: z.number(), started: instant })
  .loose()
  .meta({ id: 'Worklog' });

export const watchers = z
  .object({ watchCount: z.number(), isWatching: z.boolean(), watchers: z.array(user) })
  .loose();

export const votes = z.object({ votes: z.number(), hasVoted: z.boolean() }).loose();

export const remoteLink = z
  .object({ id: z.number(), object: z.object({ url: z.string(), title: z.string() }).loose() })
  .loose();

export const property = z.object({ key: z.string(), value: z.unknown() }).loose();
export const propertyKeys = z
  .object({ keys: z.array(z.object({ key: z.string(), self }).loose()) })
  .loose();

export const changelogEntry = z
  .object({
    id,
    author: user.nullable(),
    created: instant,
    items: z.array(
      z
        .object({
          field: z.string(),
          fromString: z.string().nullable(),
          toString: z.string().nullable(),
        })
        .loose(),
    ),
  })
  .loose();

export const searchJql = (version: '2' | '3') =>
  z
    .object({
      issues: z.array(issue(version)),
      isLast: z.boolean(),
      nextPageToken: z.string().optional(),
    })
    .loose();

export const searchLegacy = (version: '2' | '3') => offsetPage('issues', issue(version));

export const bulkCreated = z
  .object({ issues: z.array(createdIssue), errors: z.array(z.unknown()) })
  .loose();

export const bulkFetched = (version: '2' | '3') =>
  z.object({ issues: z.array(issue(version)), issueErrors: z.array(z.unknown()) }).loose();

export const bulkTask = z.object({ taskId: z.string() }).loose();
export const bulkProgress = z
  .object({
    taskId: z.string(),
    status: z.enum(['ENQUEUED', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED']),
    progressPercent: z.number(),
  })
  .loose();

export const project = z
  .object({ id, key: z.string(), name: z.string(), projectTypeKey: z.string() })
  .loose()
  .meta({ id: 'Project' });

export const version = z
  .object({ id, name: z.string(), released: z.boolean(), archived: z.boolean() })
  .loose();

export const role = z.object({ id: z.number(), name: z.string() }).loose();

export const field = z
  .object({ id: z.string(), name: z.string(), custom: z.boolean() })
  .loose()
  .meta({ id: 'Field' });

export const linkType = z
  .object({ id, name: z.string(), inward: z.string(), outward: z.string() })
  .loose();

export const filter = z
  .object({ id, name: z.string(), jql: z.string(), owner: user })
  .loose()
  .meta({ id: 'Filter' });

export const dashboard = z.object({ id, name: z.string() }).loose();

export const permissions = z
  .object({
    permissions: z.record(
      z.string(),
      z.object({ key: z.string(), havePermission: z.boolean() }).loose(),
    ),
  })
  .loose();

export const serverInfo = z
  .object({ baseUrl: z.string(), version: z.string(), deploymentType: z.string() })
  .loose();

export const group = z.object({ name: z.string(), groupId: z.string() }).loose();

export const webhook = z
  .object({ name: z.string(), url: z.string(), events: z.array(z.string()), self })
  .loose();

export const board = z
  .object({ id: z.number(), name: z.string(), type: z.enum(['scrum', 'kanban', 'simple']) })
  .loose()
  .meta({ id: 'Board' });

export const boardConfiguration = z
  .object({
    id: z.number(),
    name: z.string(),
    filter: z.object({ id }).loose(),
    columnConfig: z
      .object({
        columns: z.array(
          z.object({ name: z.string(), statuses: z.array(z.object({ id }).loose()) }).loose(),
        ),
      })
      .loose(),
  })
  .loose();

export const sprint = z
  .object({
    id: z.number(),
    name: z.string(),
    state: z.enum(['future', 'active', 'closed']),
  })
  .loose()
  .meta({ id: 'Sprint' });

export const agileIssues = (version: '2' | '3') => offsetPage('issues', issue(version));

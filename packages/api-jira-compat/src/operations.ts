import { z } from 'zod';
import * as s from './schemas';

/**
 * The Jira-compatible API's operations (M1-068; API-003 to API-007; spec 02a section 1.2;
 * ADR-016, ADR-085): what each one does, in our own words, the public pages that describe it
 * (`sources`), what those pages left unconfirmed (`verify`), and the bodies it takes and
 * answers. Nothing here is copied from Atlassian's documentation (ADR-003): the summaries are
 * ours, and the shapes name only the fields a script relies on.
 *
 * Paths under `/rest/api/{v}` exist as version 2 and version 3; `versions` lists which. The
 * Agile API lives under `/rest/agile/1.0` and the webhook registration under
 * `/rest/webhooks/1.0`.
 */
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Version = '2' | '3';
export type Family =
  | 'issues'
  | 'search'
  | 'bulk'
  | 'projects'
  | 'configuration'
  | 'filters'
  | 'users'
  | 'webhooks'
  | 'agile';

export const FAMILIES: readonly Family[] = [
  'issues',
  'search',
  'bulk',
  'projects',
  'configuration',
  'filters',
  'users',
  'webhooks',
  'agile',
];

export interface CompatResponse {
  description: string;
  /** The body by version; one schema for both when the shape is the same. */
  schema?: z.ZodType | ((version: Version) => z.ZodType);
}

export interface CompatOperation {
  id: string;
  family: Family;
  method: Method;
  /** With `{v}` for the API version and `{name}` for path parameters. */
  path: string;
  versions: readonly Version[];
  summary: string;
  description?: string;
  /** Public pages that describe the operation (provenance; ADR-003). */
  sources: readonly string[];
  /** What the sources did not settle, to confirm against recorded client traffic. */
  verify?: string;
  body?: z.ZodType | ((version: Version) => z.ZodType);
  responses: Record<number, CompatResponse>;
}

const PLATFORM = 'https://developer.atlassian.com/cloud/jira/platform/rest/v3';
const SOFTWARE = 'https://developer.atlassian.com/cloud/jira/software/rest';
const DATA_CENTER = 'https://docs.atlassian.com/software/jira/docs/api/REST/latest/';
const group = (name: string) => `${PLATFORM}/api-group-${name}/`;
const agileGroup = (name: string) => `${SOFTWARE}/api-group-${name}/`;
const BOTH: readonly Version[] = ['2', '3'];
/** The Agile API and webhooks have one version; the suite runs them once. */
const ONCE: readonly Version[] = ['2'];

const op = (o: Omit<CompatOperation, 'versions'> & { versions?: readonly Version[] }) =>
  ({ versions: BOTH, ...o }) as CompatOperation;
const noContent = { 204: { description: 'Done; no body.' } };
const issueFieldsBody = (version: Version) =>
  z
    .object({
      fields: z
        .object({
          project: z.object({ key: z.string() }).loose().optional(),
          issuetype: z.object({ name: z.string() }).loose().optional(),
          summary: z.string().optional(),
          description: s.richText(version).optional(),
          labels: z.array(z.string()).optional(),
        })
        .loose(),
    })
    .loose();

export const COMPAT_OPERATIONS: readonly CompatOperation[] = [
  // Issues.
  op({
    id: 'createIssue',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issue',
    summary: 'Create an issue from its fields',
    description:
      'Takes `fields` with at least the project, the issue type and a summary; answers the new issue’s id, key and address.',
    sources: [group('issues')],
    body: issueFieldsBody,
    responses: { 201: { description: 'Created.', schema: s.createdIssue } },
  }),
  op({
    id: 'getIssue',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}',
    summary: 'Read an issue by id or key',
    description:
      'Answers the issue with its fields; `fields` narrows them and `expand` adds sections such as the changelog or the rendered fields.',
    sources: [group('issues')],
    verify: 'Which `expand` values scripts send most, and their exact shapes.',
    responses: { 200: { description: 'The issue.', schema: s.issue } },
  }),
  op({
    id: 'editIssue',
    family: 'issues',
    method: 'PUT',
    path: '/rest/api/{v}/issue/{issueIdOrKey}',
    summary: 'Change an issue’s fields',
    description: 'Takes `fields` to set and `update` operations (add, remove, set) per field.',
    sources: [group('issues')],
    body: issueFieldsBody,
    responses: noContent,
  }),
  op({
    id: 'deleteIssue',
    family: 'issues',
    method: 'DELETE',
    path: '/rest/api/{v}/issue/{issueIdOrKey}',
    summary: 'Delete an issue',
    description:
      'With `deleteSubtasks=true`, also its subtasks; refused otherwise when it has any.',
    sources: [group('issues')],
    responses: noContent,
  }),
  op({
    id: 'getTransitions',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/transitions',
    summary: 'The transitions the caller may run on an issue now',
    sources: [group('issues')],
    responses: { 200: { description: 'The transitions.', schema: s.transitions } },
  }),
  op({
    id: 'doTransition',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/transitions',
    summary: 'Run a transition on an issue',
    description: 'Takes `transition.id`, and optionally fields and a comment the screen asks for.',
    sources: [group('issues')],
    body: z.object({ transition: z.object({ id: z.string() }).loose() }).loose(),
    responses: noContent,
  }),
  op({
    id: 'getChangelog',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/changelog',
    summary: 'An issue’s change history, a page at a time',
    sources: [group('issues')],
    responses: {
      200: { description: 'A page of changes.', schema: s.valuesPage(s.changelogEntry) },
    },
  }),
  op({
    id: 'getComments',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/comment',
    summary: 'An issue’s comments, by offset',
    sources: [group('issue-comments')],
    responses: {
      200: {
        description: 'A page of comments.',
        schema: (v) => s.offsetPage('comments', s.comment(v)),
      },
    },
  }),
  op({
    id: 'addComment',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/comment',
    summary: 'Comment on an issue',
    description:
      'Takes `body` (wiki markup on v2, a document on v3) and optionally `visibility` by role or group.',
    sources: [group('issue-comments')],
    body: (v) => z.object({ body: s.richText(v) }).loose(),
    responses: { 201: { description: 'The new comment.', schema: s.comment } },
  }),
  op({
    id: 'updateComment',
    family: 'issues',
    method: 'PUT',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/comment/{id}',
    summary: 'Change a comment',
    sources: [group('issue-comments')],
    body: (v) => z.object({ body: s.richText(v) }).loose(),
    responses: { 200: { description: 'The comment as changed.', schema: s.comment } },
  }),
  op({
    id: 'deleteComment',
    family: 'issues',
    method: 'DELETE',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/comment/{id}',
    summary: 'Delete a comment',
    sources: [group('issue-comments')],
    responses: noContent,
  }),
  op({
    id: 'getWorklogs',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/worklog',
    summary: 'Time logged on an issue, by offset',
    sources: [group('issue-worklogs')],
    responses: {
      200: { description: 'A page of worklogs.', schema: s.offsetPage('worklogs', s.worklog) },
    },
  }),
  op({
    id: 'addWorklog',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/worklog',
    summary: 'Log time on an issue',
    description:
      'Takes `timeSpentSeconds` or `timeSpent` (such as `1h 30m`), and optionally `started` and a comment.',
    sources: [group('issue-worklogs')],
    body: z.object({ timeSpentSeconds: z.number().optional() }).loose(),
    responses: { 201: { description: 'The new worklog.', schema: s.worklog } },
  }),
  op({
    id: 'getWatchers',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/watchers',
    summary: 'Who watches an issue',
    sources: [group('issue-watchers')],
    responses: { 200: { description: 'The watchers.', schema: s.watchers } },
  }),
  op({
    id: 'addWatcher',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/watchers',
    summary: 'Add a watcher to an issue',
    description: 'The body is the account id as a JSON string; without one, the caller.',
    sources: [group('issue-watchers')],
    verify: 'Whether an empty body adds the caller on both versions.',
    body: z.string(),
    responses: noContent,
  }),
  op({
    id: 'getVotes',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/votes',
    summary: 'An issue’s votes',
    sources: [group('issue-votes')],
    responses: { 200: { description: 'The votes.', schema: s.votes } },
  }),
  op({
    id: 'getRemoteLinks',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/remotelink',
    summary: 'An issue’s links to things outside it',
    sources: [group('issue-remote-links')],
    responses: { 200: { description: 'The links.', schema: z.array(s.remoteLink) } },
  }),
  op({
    id: 'addRemoteLink',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/remotelink',
    summary: 'Link an issue to an address outside it',
    description:
      'Takes `object.url` and `object.title`; with a `globalId` it updates the link that has it.',
    sources: [group('issue-remote-links')],
    body: z.object({ object: z.object({ url: z.string(), title: z.string() }).loose() }).loose(),
    responses: {
      201: {
        description: 'Created.',
        schema: z.object({ id: z.number(), self: z.string() }).loose(),
      },
      200: {
        description: 'The link with that global id, updated.',
        schema: z.object({ id: z.number(), self: z.string() }).loose(),
      },
    },
  }),
  op({
    id: 'getIssuePropertyKeys',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/properties',
    summary: 'The keys of an issue’s properties',
    sources: [group('issue-properties')],
    responses: { 200: { description: 'The keys.', schema: s.propertyKeys } },
  }),
  op({
    id: 'setIssueProperty',
    family: 'issues',
    method: 'PUT',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/properties/{propertyKey}',
    summary: 'Set an issue property to a JSON value',
    description: 'The body is the value itself. 201 when the key is new, 200 when it is replaced.',
    sources: [group('issue-properties')],
    body: z.unknown(),
    responses: {
      200: { description: 'Replaced.' },
      201: { description: 'Created.' },
    },
  }),
  op({
    id: 'getIssueProperty',
    family: 'issues',
    method: 'GET',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/properties/{propertyKey}',
    summary: 'Read an issue property',
    sources: [group('issue-properties')],
    responses: { 200: { description: 'The key and its value.', schema: s.property } },
  }),
  op({
    id: 'deleteIssueProperty',
    family: 'issues',
    method: 'DELETE',
    path: '/rest/api/{v}/issue/{issueIdOrKey}/properties/{propertyKey}',
    summary: 'Delete an issue property',
    sources: [group('issue-properties')],
    responses: noContent,
  }),
  op({
    id: 'linkIssues',
    family: 'issues',
    method: 'POST',
    path: '/rest/api/{v}/issueLink',
    summary: 'Link two issues',
    description: 'Takes the link type by name, the inward issue and the outward issue, by key.',
    sources: [group('issue-links')],
    body: z
      .object({
        type: z.object({ name: z.string() }).loose(),
        inwardIssue: z.object({ key: z.string() }).loose(),
        outwardIssue: z.object({ key: z.string() }).loose(),
      })
      .loose(),
    responses: { 201: { description: 'Linked.' } },
  }),

  // Search.
  op({
    id: 'searchJql',
    family: 'search',
    method: 'POST',
    path: '/rest/api/{v}/search/jql',
    summary: 'Search with a query, a page at a time by token',
    description:
      'Takes `jql`, `maxResults`, `fields` and the `nextPageToken` of the previous page; answers the issues and `isLast`, without a total.',
    sources: [
      group('issue-search'),
      'https://confluence.atlassian.com/display/JIRAKB/Run+JQL+search+query+using+Jira+Cloud+REST+API',
    ],
    body: z
      .object({
        jql: z.string(),
        maxResults: z.number().optional(),
        nextPageToken: z.string().optional(),
        fields: z.array(z.string()).optional(),
      })
      .loose(),
    responses: { 200: { description: 'A page of issues.', schema: s.searchJql } },
  }),
  op({
    id: 'searchJqlGet',
    family: 'search',
    method: 'GET',
    path: '/rest/api/{v}/search/jql',
    summary: 'The same search in the query string',
    sources: [group('issue-search')],
    responses: { 200: { description: 'A page of issues.', schema: s.searchJql } },
  }),
  op({
    id: 'searchLegacy',
    family: 'search',
    method: 'GET',
    path: '/rest/api/{v}/search',
    summary: 'The older search by offset, with a total',
    description:
      'Takes `jql`, `startAt` and `maxResults`; answers the issues and `total`. Data Center scripts still use it, though the hosted service retired it.',
    sources: [DATA_CENTER, group('issue-search')],
    verify: 'The largest `maxResults` scripts rely on.',
    responses: { 200: { description: 'A page of issues.', schema: s.searchLegacy } },
  }),
  op({
    id: 'searchLegacyPost',
    family: 'search',
    method: 'POST',
    path: '/rest/api/{v}/search',
    summary: 'The older search with the query in the body',
    sources: [DATA_CENTER],
    body: z.object({ jql: z.string(), startAt: z.number().optional() }).loose(),
    responses: { 200: { description: 'A page of issues.', schema: s.searchLegacy } },
  }),

  // Bulk.
  op({
    id: 'createIssues',
    family: 'bulk',
    method: 'POST',
    path: '/rest/api/{v}/issue/bulk',
    summary: 'Create several issues at once',
    description:
      'Takes `issueUpdates`, each like one create; answers the ones made and the errors.',
    sources: [group('issues')],
    body: (v) => z.object({ issueUpdates: z.array(issueFieldsBody(v)) }).loose(),
    responses: { 201: { description: 'What was created.', schema: s.bulkCreated } },
  }),
  op({
    id: 'bulkFetchIssues',
    family: 'bulk',
    method: 'POST',
    path: '/rest/api/{v}/issue/bulkfetch',
    summary: 'Read up to a hundred issues by id or key',
    sources: [group('issues')],
    body: z.object({ issueIdsOrKeys: z.array(z.string()) }).loose(),
    responses: { 200: { description: 'The issues found.', schema: s.bulkFetched } },
  }),
  op({
    id: 'bulkEditFields',
    family: 'bulk',
    method: 'POST',
    path: '/rest/api/{v}/bulk/issues/fields',
    summary: 'Change fields of many issues as a task',
    sources: [
      group('issue-bulk-operations'),
      'https://community.developer.atlassian.com/t/rfc-145-jira-cloud-rest-api-async-bulk-mutation-apis/102577',
    ],
    verify: 'The body’s exact shape for each kind of field.',
    responses: { 201: { description: 'The task.', schema: s.bulkTask } },
  }),
  op({
    id: 'bulkTransition',
    family: 'bulk',
    method: 'POST',
    path: '/rest/api/{v}/bulk/issues/transition',
    summary: 'Run transitions on many issues as a task',
    sources: [group('issue-bulk-operations')],
    body: z
      .object({
        bulkTransitionInputs: z.array(
          z.object({ selectedIssueIdsOrKeys: z.array(z.string()), transitionId: z.string() }),
        ),
      })
      .loose(),
    responses: { 201: { description: 'The task.', schema: s.bulkTask } },
  }),
  op({
    id: 'bulkDelete',
    family: 'bulk',
    method: 'POST',
    path: '/rest/api/{v}/bulk/issues/delete',
    summary: 'Delete many issues as a task',
    sources: [group('issue-bulk-operations')],
    body: z.object({ selectedIssueIdsOrKeys: z.array(z.string()) }).loose(),
    responses: { 201: { description: 'The task.', schema: s.bulkTask } },
  }),
  op({
    id: 'bulkProgress',
    family: 'bulk',
    method: 'GET',
    path: '/rest/api/{v}/bulk/queue/{taskId}',
    summary: 'How far a bulk task has come',
    sources: [group('issue-bulk-operations')],
    responses: { 200: { description: 'Its progress.', schema: s.bulkProgress } },
  }),

  // Projects.
  op({
    id: 'searchProjects',
    family: 'projects',
    method: 'GET',
    path: '/rest/api/{v}/project/search',
    summary: 'Projects the caller sees, a page at a time',
    sources: [group('projects')],
    responses: { 200: { description: 'A page of projects.', schema: s.valuesPage(s.project) } },
  }),
  op({
    id: 'getProject',
    family: 'projects',
    method: 'GET',
    path: '/rest/api/{v}/project/{projectIdOrKey}',
    summary: 'Read a project by id or key',
    sources: [group('projects')],
    responses: { 200: { description: 'The project.', schema: s.project } },
  }),
  op({
    id: 'getProjects',
    family: 'projects',
    method: 'GET',
    path: '/rest/api/{v}/project',
    summary: 'Every project the caller sees, in one list',
    sources: [group('projects'), DATA_CENTER],
    verify: 'Deprecated on the hosted service; Data Center scripts call it.',
    responses: { 200: { description: 'The projects.', schema: z.array(s.project) } },
  }),
  op({
    id: 'getProjectComponents',
    family: 'projects',
    method: 'GET',
    path: '/rest/api/{v}/project/{projectIdOrKey}/components',
    summary: 'A project’s components',
    sources: [group('project-components')],
    responses: { 200: { description: 'The components.', schema: z.array(s.named) } },
  }),
  op({
    id: 'getProjectVersions',
    family: 'projects',
    method: 'GET',
    path: '/rest/api/{v}/project/{projectIdOrKey}/versions',
    summary: 'A project’s versions',
    sources: [group('project-versions')],
    responses: { 200: { description: 'The versions.', schema: z.array(s.version) } },
  }),
  op({
    id: 'createVersion',
    family: 'projects',
    method: 'POST',
    path: '/rest/api/{v}/version',
    summary: 'Create a version in a project',
    sources: [group('project-versions')],
    body: z.object({ name: z.string(), projectId: z.number().optional() }).loose(),
    responses: { 201: { description: 'The version.', schema: s.version } },
  }),
  op({
    id: 'getProjectRoles',
    family: 'projects',
    method: 'GET',
    path: '/rest/api/{v}/project/{projectIdOrKey}/role',
    summary: 'A project’s roles, as names to addresses',
    sources: [group('project-roles')],
    responses: {
      200: { description: 'Role names and addresses.', schema: z.record(z.string(), z.string()) },
    },
  }),

  // Configuration.
  op({
    id: 'getFields',
    family: 'configuration',
    method: 'GET',
    path: '/rest/api/{v}/field',
    summary: 'Every field, built-in and custom',
    sources: [group('issue-fields')],
    responses: { 200: { description: 'The fields.', schema: z.array(s.field) } },
  }),
  op({
    id: 'getIssueTypes',
    family: 'configuration',
    method: 'GET',
    path: '/rest/api/{v}/issuetype',
    summary: 'The issue types the caller may use',
    sources: [group('issue-types')],
    responses: { 200: { description: 'The issue types.', schema: z.array(s.issueType) } },
  }),
  op({
    id: 'getPriorities',
    family: 'configuration',
    method: 'GET',
    path: '/rest/api/{v}/priority',
    summary: 'The priorities',
    sources: [group('issue-priorities')],
    responses: { 200: { description: 'The priorities.', schema: z.array(s.named) } },
  }),
  op({
    id: 'getResolutions',
    family: 'configuration',
    method: 'GET',
    path: '/rest/api/{v}/resolution',
    summary: 'The resolutions',
    sources: [group('issue-resolutions')],
    responses: { 200: { description: 'The resolutions.', schema: z.array(s.named) } },
  }),
  op({
    id: 'getStatuses',
    family: 'configuration',
    method: 'GET',
    path: '/rest/api/{v}/status',
    summary: 'The statuses, with their categories',
    sources: [group('workflow-statuses')],
    responses: { 200: { description: 'The statuses.', schema: z.array(s.status) } },
  }),
  op({
    id: 'getLinkTypes',
    family: 'configuration',
    method: 'GET',
    path: '/rest/api/{v}/issueLinkType',
    summary: 'The issue link types',
    sources: [group('issue-link-types')],
    responses: {
      200: {
        description: 'The link types.',
        schema: z.object({ issueLinkTypes: z.array(s.linkType) }).loose(),
      },
    },
  }),

  // Filters and dashboards.
  op({
    id: 'createFilter',
    family: 'filters',
    method: 'POST',
    path: '/rest/api/{v}/filter',
    summary: 'Save a search as a filter',
    sources: [group('filters')],
    body: z.object({ name: z.string(), jql: z.string() }).loose(),
    responses: { 200: { description: 'The filter.', schema: s.filter } },
    verify: 'Whether creation answers 200 or 201.',
  }),
  op({
    id: 'getFilter',
    family: 'filters',
    method: 'GET',
    path: '/rest/api/{v}/filter/{id}',
    summary: 'Read a filter',
    sources: [group('filters')],
    responses: { 200: { description: 'The filter.', schema: s.filter } },
  }),
  op({
    id: 'getFavouriteFilters',
    family: 'filters',
    method: 'GET',
    path: '/rest/api/{v}/filter/favourite',
    summary: 'The caller’s favourite filters',
    sources: [group('filters')],
    responses: { 200: { description: 'The filters.', schema: z.array(s.filter) } },
  }),
  op({
    id: 'getDashboards',
    family: 'filters',
    method: 'GET',
    path: '/rest/api/{v}/dashboard',
    summary: 'Dashboards the caller sees',
    sources: [group('dashboards')],
    verify: 'The gadget shapes behind each dashboard.',
    responses: {
      200: {
        description: 'A page of dashboards.',
        schema: s.offsetPage('dashboards', s.dashboard),
      },
    },
  }),

  // Users and permissions.
  op({
    id: 'getMyself',
    family: 'users',
    method: 'GET',
    path: '/rest/api/{v}/myself',
    summary: 'The caller',
    sources: [group('myself')],
    responses: { 200: { description: 'The caller.', schema: s.user } },
  }),
  op({
    id: 'searchUsers',
    family: 'users',
    method: 'GET',
    path: '/rest/api/{v}/user/search',
    summary: 'Find people by part of their name or address',
    sources: [group('user-search')],
    verify: 'Which parameter names Data Center scripts send (`query` or `username`).',
    responses: { 200: { description: 'The people found.', schema: z.array(s.user) } },
  }),
  op({
    id: 'getUser',
    family: 'users',
    method: 'GET',
    path: '/rest/api/{v}/user',
    summary: 'A person by account id',
    sources: [group('users')],
    responses: { 200: { description: 'The person.', schema: s.user } },
  }),
  op({
    id: 'findGroups',
    family: 'users',
    method: 'GET',
    path: '/rest/api/{v}/groups/picker',
    summary: 'Find groups by part of their name',
    sources: [group('groups')],
    responses: {
      200: {
        description: 'The groups found.',
        schema: z.object({ groups: z.array(s.group), total: z.number() }).loose(),
      },
    },
  }),
  op({
    id: 'getMyPermissions',
    family: 'users',
    method: 'GET',
    path: '/rest/api/{v}/mypermissions',
    summary: 'Whether the caller holds the named permissions',
    description: 'Takes `permissions` as a comma-separated list, and optionally a project.',
    sources: [group('permissions')],
    responses: { 200: { description: 'Each permission.', schema: s.permissions } },
  }),
  op({
    id: 'getServerInfo',
    family: 'users',
    method: 'GET',
    path: '/rest/api/{v}/serverInfo',
    summary: 'What this server is: its address, version and kind',
    sources: [group('server-info')],
    responses: { 200: { description: 'The server.', schema: s.serverInfo } },
  }),

  // Webhooks (administrator registration).
  op({
    id: 'registerWebhook',
    family: 'webhooks',
    method: 'POST',
    path: '/rest/webhooks/1.0/webhook',
    versions: ONCE,
    summary: 'Register a webhook as an administrator',
    description: 'Takes a name, an address, the events and optionally a query to filter by.',
    sources: ['https://developer.atlassian.com/cloud/jira/platform/webhooks/'],
    verify: 'The answer’s exact status and fields.',
    body: z.object({ name: z.string(), url: z.string(), events: z.array(z.string()) }).loose(),
    responses: { 201: { description: 'The webhook.', schema: s.webhook } },
  }),
  op({
    id: 'listWebhooks',
    family: 'webhooks',
    method: 'GET',
    path: '/rest/webhooks/1.0/webhook',
    versions: ONCE,
    summary: 'The registered webhooks',
    sources: ['https://developer.atlassian.com/cloud/jira/platform/webhooks/'],
    responses: { 200: { description: 'The webhooks.', schema: z.array(s.webhook) } },
  }),

  // Agile.
  op({
    id: 'getBoards',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board',
    versions: ONCE,
    summary: 'Boards the caller sees, a page at a time',
    sources: [agileGroup('board'), `${SOFTWARE}/intro/`],
    responses: { 200: { description: 'A page of boards.', schema: s.valuesPage(s.board) } },
  }),
  op({
    id: 'getBoard',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board/{boardId}',
    versions: ONCE,
    summary: 'Read a board',
    sources: [agileGroup('board')],
    responses: { 200: { description: 'The board.', schema: s.board } },
  }),
  op({
    id: 'getBoardConfiguration',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board/{boardId}/configuration',
    versions: ONCE,
    summary: 'A board’s columns and filter',
    sources: [agileGroup('board')],
    responses: { 200: { description: 'The configuration.', schema: s.boardConfiguration } },
  }),
  op({
    id: 'getBoardIssues',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board/{boardId}/issue',
    versions: ONCE,
    summary: 'The issues on a board, by offset',
    sources: [agileGroup('board')],
    responses: { 200: { description: 'A page of issues.', schema: s.agileIssues('2') } },
  }),
  op({
    id: 'getBoardBacklog',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board/{boardId}/backlog',
    versions: ONCE,
    summary: 'A board’s backlog: its issues in no open sprint',
    sources: [agileGroup('board')],
    responses: { 200: { description: 'A page of issues.', schema: s.agileIssues('2') } },
  }),
  op({
    id: 'getBoardSprints',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board/{boardId}/sprint',
    versions: ONCE,
    summary: 'A board’s sprints, a page at a time',
    sources: [agileGroup('board')],
    responses: { 200: { description: 'A page of sprints.', schema: s.valuesPage(s.sprint) } },
  }),
  op({
    id: 'createSprint',
    family: 'agile',
    method: 'POST',
    path: '/rest/agile/1.0/sprint',
    versions: ONCE,
    summary: 'Create a future sprint on a board',
    sources: [agileGroup('sprint')],
    body: z.object({ name: z.string(), originBoardId: z.number() }).loose(),
    responses: { 201: { description: 'The sprint.', schema: s.sprint } },
  }),
  op({
    id: 'getSprint',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/sprint/{sprintId}',
    versions: ONCE,
    summary: 'Read a sprint',
    sources: [agileGroup('sprint')],
    responses: { 200: { description: 'The sprint.', schema: s.sprint } },
  }),
  op({
    id: 'updateSprint',
    family: 'agile',
    method: 'POST',
    path: '/rest/agile/1.0/sprint/{sprintId}',
    versions: ONCE,
    summary: 'Change part of a sprint; with a state, start or complete it',
    sources: [agileGroup('sprint')],
    verify: 'The rules for dates when a sprint starts this way.',
    body: z.object({ state: z.enum(['active', 'closed']).optional() }).loose(),
    responses: { 200: { description: 'The sprint as changed.', schema: s.sprint } },
  }),
  op({
    id: 'moveToSprint',
    family: 'agile',
    method: 'POST',
    path: '/rest/agile/1.0/sprint/{sprintId}/issue',
    versions: ONCE,
    summary: 'Put issues into a sprint',
    sources: [agileGroup('sprint')],
    body: z.object({ issues: z.array(z.string()) }).loose(),
    responses: noContent,
  }),
  op({
    id: 'getSprintIssues',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/sprint/{sprintId}/issue',
    versions: ONCE,
    summary: 'The issues in a sprint, by offset',
    sources: [agileGroup('sprint')],
    responses: { 200: { description: 'A page of issues.', schema: s.agileIssues('2') } },
  }),
  op({
    id: 'moveToBacklog',
    family: 'agile',
    method: 'POST',
    path: '/rest/agile/1.0/backlog/issue',
    versions: ONCE,
    summary: 'Take issues out of their sprints, back to the backlog',
    sources: [agileGroup('backlog')],
    body: z.object({ issues: z.array(z.string()) }).loose(),
    responses: noContent,
  }),
  op({
    id: 'rankIssues',
    family: 'agile',
    method: 'PUT',
    path: '/rest/agile/1.0/issue/rank',
    versions: ONCE,
    summary: 'Rank issues before or after another one',
    sources: [agileGroup('issue')],
    body: z
      .object({
        issues: z.array(z.string()),
        rankBeforeIssue: z.string().optional(),
        rankAfterIssue: z.string().optional(),
      })
      .loose(),
    responses: noContent,
  }),
  op({
    id: 'getAgileIssue',
    family: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/issue/{issueIdOrKey}',
    versions: ONCE,
    summary: 'Read an issue with its agile fields (sprint, epic, estimate)',
    sources: [agileGroup('issue')],
    verify: 'Which agile fields scripts read from it.',
    responses: { 200: { description: 'The issue.', schema: s.issue('2') } },
  }),
];

/** An operation by id; throws for an unknown one, which is a mistake in the suite. */
export function compatOperation(id: string): CompatOperation {
  const found = COMPAT_OPERATIONS.find((o) => o.id === id);
  if (!found) throw new Error(`Unknown compatible operation ${id}`);
  return found;
}

/** The path of an operation at a version, with its parameters filled in. */
export function compatPath(
  operation: CompatOperation,
  version: Version,
  params: Record<string, string | number> = {},
): string {
  return operation.path.replace('{v}', version).replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${operation.id} needs ${name}`);
    return encodeURIComponent(String(value));
  });
}

/** The schema a response is checked against, at a version. */
export function responseSchema(
  operation: CompatOperation,
  status: number,
  version: Version,
): z.ZodType | undefined {
  const schema = operation.responses[status]?.schema;
  if (!schema) return undefined;
  return typeof schema === 'function' && !(schema instanceof z.ZodType) ? schema(version) : schema;
}

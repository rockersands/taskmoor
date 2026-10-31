import type { Version } from './operations';

/**
 * The conformance cases of the Jira-compatible API (M1-068; API-003 to API-007, API-014;
 * ADR-085): what a script sends and what it must get back, with synthetic data only (ADR-003:
 * nothing is recorded from an Atlassian product). They run in order, once per API version the
 * operation has, and later cases use what earlier ones made (`capture`, `needs`): the suite
 * creates its own issues in the project the target names, so it starts from any instance where
 * the caller may create issues and administer.
 *
 * A case passes when the status is the expected one, the body matches the operation's schema
 * for that status (a refusal must look like a Jira-compatible error), and `check` finds nothing
 * wrong.
 */
export interface CaseContext {
  version: Version;
  /** The key of a project the caller may create issues in. */
  project: string;
  /** An issue type that project takes, by name. */
  issueType: string;
  /** A Scrum board of that project, for the Agile cases. */
  boardId: number | null;
  /** What earlier cases captured, for this version's run. */
  vars: Map<string, string | number>;
}

export interface CaseRequest {
  params?: Record<string, string | number>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface CompatCase {
  id: string;
  operation: string;
  /** In our own words: what a script relies on here. */
  name: string;
  /** Only these versions; by default every version of the operation. */
  versions?: readonly Version[];
  /** Captured values the case needs; without them it is skipped. */
  needs?: readonly string[];
  request: (ctx: CaseContext) => CaseRequest;
  status: number;
  /** A refusal: the body must be a Jira-compatible error. */
  error?: boolean;
  check?: (body: unknown, ctx: CaseContext) => string | null;
  capture?: (body: unknown, ctx: CaseContext) => void;
}

/** A value at a dot path of a JSON body, or undefined. */
export function at(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const v = (ctx: CaseContext, name: string) => {
  const value = ctx.vars.get(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
};
const expectEqual = (actual: unknown, expected: unknown, what: string) =>
  actual === expected
    ? null
    : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
const list = (body: unknown, path = ''): unknown[] => {
  const value = path === '' ? body : at(body, path);
  return Array.isArray(value) ? value : [];
};
const includes = (items: unknown[], path: string, wanted: unknown, what: string) =>
  items.some((i) => at(i, path) === wanted) ? null : `${what}: ${JSON.stringify(wanted)} not found`;

/** Rich text as each version carries it: wiki markup on v2, a document on v3. */
const richText = (ctx: CaseContext, text: string) =>
  ctx.version === '2'
    ? text
    : {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      };
const richTextHas = (ctx: CaseContext, value: unknown, text: string) => {
  const flat = ctx.version === '2' ? String(value ?? '') : JSON.stringify(value ?? null);
  return flat.includes(text) ? null : `rich text without ${JSON.stringify(text)}`;
};

const createBody = (ctx: CaseContext, summary: string) => ({
  fields: {
    project: { key: ctx.project },
    issuetype: { name: ctx.issueType },
    summary,
    labels: ['contract'],
    description: richText(ctx, 'Made by the conformance suite'),
  },
});
const issue =
  (name = 'issue') =>
  (ctx: CaseContext) => ({
    params: { issueIdOrKey: v(ctx, `${name}.key`) },
  });

export const COMPAT_CASES: readonly CompatCase[] = [
  // Who the caller is, first: later cases use the account id.
  {
    id: 'getMyself.caller',
    operation: 'getMyself',
    name: 'Names the caller with an account id',
    request: () => ({}),
    status: 200,
    capture: (body, ctx) => {
      ctx.vars.set('me.accountId', String(at(body, 'accountId')));
      ctx.vars.set('me.displayName', String(at(body, 'displayName')));
    },
  },
  {
    id: 'getServerInfo.basic',
    operation: 'getServerInfo',
    name: 'Says what the server is',
    request: () => ({}),
    status: 200,
  },
  {
    id: 'searchUsers.byName',
    operation: 'searchUsers',
    name: 'Finds the caller by part of their name',
    needs: ['me.displayName'],
    request: (ctx) => ({ query: { query: String(v(ctx, 'me.displayName')).slice(0, 3) } }),
    status: 200,
    check: (body, ctx) => includes(list(body), 'accountId', v(ctx, 'me.accountId'), 'users'),
  },
  {
    id: 'getUser.byAccountId',
    operation: 'getUser',
    name: 'Reads a person by account id',
    needs: ['me.accountId'],
    request: (ctx) => ({ query: { accountId: String(v(ctx, 'me.accountId')) } }),
    status: 200,
    check: (body, ctx) => expectEqual(at(body, 'accountId'), v(ctx, 'me.accountId'), 'accountId'),
  },
  {
    id: 'findGroups.any',
    operation: 'findGroups',
    name: 'Answers a group search, even an empty one',
    request: () => ({ query: { query: '' } }),
    status: 200,
  },
  {
    id: 'getMyPermissions.create',
    operation: 'getMyPermissions',
    name: 'Says the caller may browse and create in the project',
    request: (ctx) => ({
      query: { projectKey: ctx.project, permissions: 'BROWSE_PROJECTS,CREATE_ISSUES' },
    }),
    status: 200,
    check: (body) =>
      at(body, 'permissions.BROWSE_PROJECTS.havePermission') === true &&
      at(body, 'permissions.CREATE_ISSUES.havePermission') === true
        ? null
        : 'expected both permissions held',
  },

  // Issues.
  {
    id: 'createIssue.basic',
    operation: 'createIssue',
    name: 'Creates an issue from project, type, summary, labels and description',
    request: (ctx) => ({ body: createBody(ctx, 'Contract issue') }),
    status: 201,
    check: (body, ctx) =>
      String(at(body, 'key')).startsWith(`${ctx.project}-`) ? null : 'key not in the project',
    capture: (body, ctx) => {
      ctx.vars.set('issue.key', String(at(body, 'key')));
      ctx.vars.set('issue.id', String(at(body, 'id')));
    },
  },
  {
    id: 'createIssue.second',
    operation: 'createIssue',
    name: 'Creates a second issue',
    request: (ctx) => ({ body: createBody(ctx, 'Contract issue two') }),
    status: 201,
    capture: (body, ctx) => ctx.vars.set('issue2.key', String(at(body, 'key'))),
  },
  {
    id: 'createIssue.noSummary',
    operation: 'createIssue',
    name: 'Refuses an issue without a summary, naming the field',
    request: (ctx) => ({
      body: { fields: { project: { key: ctx.project }, issuetype: { name: ctx.issueType } } },
    }),
    status: 400,
    error: true,
    check: (body) => (at(body, 'errors.summary') ? null : 'no error for summary'),
  },
  {
    id: 'getIssue.byKey',
    operation: 'getIssue',
    name: 'Reads the issue by key with its fields',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body, ctx) =>
      expectEqual(at(body, 'fields.summary'), 'Contract issue', 'summary') ??
      (list(body, 'fields.labels').includes('contract') ? null : 'label missing') ??
      richTextHas(ctx, at(body, 'fields.description'), 'Made by the conformance suite'),
  },
  {
    id: 'getIssue.byId',
    operation: 'getIssue',
    name: 'Reads the same issue by id',
    needs: ['issue.id', 'issue.key'],
    request: (ctx) => ({ params: { issueIdOrKey: v(ctx, 'issue.id') } }),
    status: 200,
    check: (body, ctx) => expectEqual(at(body, 'key'), v(ctx, 'issue.key'), 'key'),
  },
  {
    id: 'getIssue.fields',
    operation: 'getIssue',
    name: 'Narrows the fields with `fields`',
    needs: ['issue.key'],
    request: (ctx) => ({ ...issue()(ctx), query: { fields: 'summary,status' } }),
    status: 200,
    check: (body) => (typeof at(body, 'fields.summary') === 'string' ? null : 'no summary'),
  },
  {
    id: 'getIssue.unknown',
    operation: 'getIssue',
    name: 'Answers 404 with an error body for an issue that does not exist',
    request: (ctx) => ({ params: { issueIdOrKey: `${ctx.project}-999999` } }),
    status: 404,
    error: true,
  },
  {
    id: 'editIssue.summary',
    operation: 'editIssue',
    name: 'Changes the summary through `fields`',
    needs: ['issue.key'],
    request: (ctx) => ({
      ...issue()(ctx),
      body: { fields: { summary: 'Contract issue, edited' } },
    }),
    status: 204,
  },
  {
    id: 'editIssue.addLabel',
    operation: 'editIssue',
    name: 'Adds a label through `update`',
    needs: ['issue.key'],
    request: (ctx) => ({ ...issue()(ctx), body: { update: { labels: [{ add: 'second' }] } } }),
    status: 204,
  },
  {
    id: 'getIssue.afterEdit',
    operation: 'getIssue',
    name: 'Shows both edits',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) =>
      expectEqual(at(body, 'fields.summary'), 'Contract issue, edited', 'summary') ??
      (['contract', 'second'].every((l) => list(body, 'fields.labels').includes(l))
        ? null
        : 'labels not both there'),
  },
  {
    id: 'getTransitions.some',
    operation: 'getTransitions',
    name: 'Lists at least one transition with its target status',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) => (list(body, 'transitions').length > 0 ? null : 'no transitions'),
    capture: (body, ctx) => {
      const first = list(body, 'transitions')[0];
      ctx.vars.set('transition.id', String(at(first, 'id')));
      ctx.vars.set('transition.to', String(at(first, 'to.name')));
    },
  },
  {
    id: 'doTransition.run',
    operation: 'doTransition',
    name: 'Runs the transition',
    needs: ['issue.key', 'transition.id'],
    request: (ctx) => ({
      ...issue()(ctx),
      body: { transition: { id: String(v(ctx, 'transition.id')) } },
    }),
    status: 204,
  },
  {
    id: 'getIssue.afterTransition',
    operation: 'getIssue',
    name: 'Shows the status the transition led to',
    needs: ['issue.key', 'transition.to'],
    request: issue(),
    status: 200,
    check: (body, ctx) =>
      expectEqual(at(body, 'fields.status.name'), v(ctx, 'transition.to'), 'status'),
  },
  {
    id: 'doTransition.unknown',
    operation: 'doTransition',
    name: 'Refuses a transition that does not exist',
    needs: ['issue.key'],
    request: (ctx) => ({ ...issue()(ctx), body: { transition: { id: '999999' } } }),
    status: 400,
    error: true,
  },
  {
    id: 'getChangelog.summary',
    operation: 'getChangelog',
    name: 'Has the summary change in the history',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) =>
      list(body, 'values').some((e) => list(e, 'items').some((i) => at(i, 'field') === 'summary'))
        ? null
        : 'no summary change',
  },
  {
    id: 'addComment.basic',
    operation: 'addComment',
    name: 'Adds a comment in the version’s rich text',
    needs: ['issue.key'],
    request: (ctx) => ({ ...issue()(ctx), body: { body: richText(ctx, 'A contract comment') } }),
    status: 201,
    check: (body, ctx) => richTextHas(ctx, at(body, 'body'), 'A contract comment'),
    capture: (body, ctx) => ctx.vars.set('comment.id', String(at(body, 'id'))),
  },
  {
    id: 'getComments.one',
    operation: 'getComments',
    name: 'Lists the comment with a total',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) => expectEqual(at(body, 'total'), 1, 'total'),
  },
  {
    id: 'updateComment.body',
    operation: 'updateComment',
    name: 'Changes the comment',
    needs: ['issue.key', 'comment.id'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), id: v(ctx, 'comment.id') },
      body: { body: richText(ctx, 'A changed comment') },
    }),
    status: 200,
    check: (body, ctx) => richTextHas(ctx, at(body, 'body'), 'A changed comment'),
  },
  {
    id: 'deleteComment.basic',
    operation: 'deleteComment',
    name: 'Deletes the comment',
    needs: ['issue.key', 'comment.id'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), id: v(ctx, 'comment.id') },
    }),
    status: 204,
  },
  {
    id: 'addWorklog.seconds',
    operation: 'addWorklog',
    name: 'Logs an hour and a half',
    needs: ['issue.key'],
    request: (ctx) => ({
      ...issue()(ctx),
      body: { timeSpentSeconds: 5400, started: '2026-10-30T09:00:00.000+0000' },
    }),
    status: 201,
    check: (body) => expectEqual(at(body, 'timeSpentSeconds'), 5400, 'timeSpentSeconds'),
  },
  {
    id: 'getWorklogs.one',
    operation: 'getWorklogs',
    name: 'Lists the worklog',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) => expectEqual(at(body, 'total'), 1, 'total'),
  },
  {
    id: 'addWatcher.caller',
    operation: 'addWatcher',
    name: 'Adds the caller as a watcher by account id',
    needs: ['issue2.key', 'me.accountId'],
    request: (ctx) => ({ ...issue('issue2')(ctx), body: String(v(ctx, 'me.accountId')) }),
    status: 204,
  },
  {
    id: 'getWatchers.caller',
    operation: 'getWatchers',
    name: 'Says the caller watches',
    needs: ['issue2.key'],
    request: issue('issue2'),
    status: 200,
    check: (body) => expectEqual(at(body, 'isWatching'), true, 'isWatching'),
  },
  {
    id: 'getVotes.none',
    operation: 'getVotes',
    name: 'Counts the votes',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) => (typeof at(body, 'votes') === 'number' ? null : 'no vote count'),
  },
  {
    id: 'addRemoteLink.new',
    operation: 'addRemoteLink',
    name: 'Links to an address outside, with a global id',
    needs: ['issue.key'],
    request: (ctx) => ({
      ...issue()(ctx),
      body: {
        globalId: 'contract-pr-1',
        object: { url: 'https://code.example.com/pr/1', title: 'Pull request 1' },
      },
    }),
    status: 201,
  },
  {
    id: 'addRemoteLink.sameGlobalId',
    operation: 'addRemoteLink',
    name: 'Updates the link with the same global id instead of adding one',
    needs: ['issue.key'],
    request: (ctx) => ({
      ...issue()(ctx),
      body: {
        globalId: 'contract-pr-1',
        object: { url: 'https://code.example.com/pr/1', title: 'Pull request 1 (merged)' },
      },
    }),
    status: 200,
  },
  {
    id: 'getRemoteLinks.one',
    operation: 'getRemoteLinks',
    name: 'Lists one link, as updated',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) =>
      list(body).length === 1
        ? expectEqual(at(list(body)[0], 'object.title'), 'Pull request 1 (merged)', 'title')
        : `expected one link, got ${list(body).length}`,
  },
  {
    id: 'setIssueProperty.new',
    operation: 'setIssueProperty',
    name: 'Sets a new property',
    needs: ['issue.key'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), propertyKey: 'contract.review' },
      body: { state: 'pending', reviewers: 2 },
    }),
    status: 201,
  },
  {
    id: 'setIssueProperty.replace',
    operation: 'setIssueProperty',
    name: 'Replaces it',
    needs: ['issue.key'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), propertyKey: 'contract.review' },
      body: { state: 'approved' },
    }),
    status: 200,
  },
  {
    id: 'getIssueProperty.value',
    operation: 'getIssueProperty',
    name: 'Reads the value back',
    needs: ['issue.key'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), propertyKey: 'contract.review' },
    }),
    status: 200,
    check: (body) => expectEqual(at(body, 'value.state'), 'approved', 'value.state'),
  },
  {
    id: 'getIssuePropertyKeys.one',
    operation: 'getIssuePropertyKeys',
    name: 'Lists the key',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body) => includes(list(body, 'keys'), 'key', 'contract.review', 'keys'),
  },
  {
    id: 'deleteIssueProperty.basic',
    operation: 'deleteIssueProperty',
    name: 'Deletes it',
    needs: ['issue.key'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), propertyKey: 'contract.review' },
    }),
    status: 204,
  },
  {
    id: 'getIssueProperty.gone',
    operation: 'getIssueProperty',
    name: 'Answers 404 once it is deleted',
    needs: ['issue.key'],
    request: (ctx) => ({
      params: { issueIdOrKey: v(ctx, 'issue.key'), propertyKey: 'contract.review' },
    }),
    status: 404,
    error: true,
  },
  {
    id: 'linkIssues.blocks',
    operation: 'linkIssues',
    name: 'Links the two issues with Blocks',
    needs: ['issue.key', 'issue2.key'],
    request: (ctx) => ({
      body: {
        type: { name: 'Blocks' },
        inwardIssue: { key: v(ctx, 'issue2.key') },
        outwardIssue: { key: v(ctx, 'issue.key') },
      },
    }),
    status: 201,
  },

  // Search.
  {
    id: 'searchJql.firstPage',
    operation: 'searchJql',
    name: 'Answers the first page of one and a token for the next',
    request: (ctx) => ({
      body: {
        jql: `project = ${ctx.project} AND labels = contract ORDER BY key ASC`,
        maxResults: 1,
        fields: ['summary'],
      },
    }),
    status: 200,
    check: (body) =>
      list(body, 'issues').length === 1 && at(body, 'isLast') === false
        ? null
        : 'expected one issue and more to come',
    capture: (body, ctx) => ctx.vars.set('search.token', String(at(body, 'nextPageToken'))),
  },
  {
    id: 'searchJql.nextPage',
    operation: 'searchJql',
    name: 'Answers the next page with the token, to the last',
    needs: ['search.token'],
    request: (ctx) => ({
      body: {
        jql: `project = ${ctx.project} AND labels = contract ORDER BY key ASC`,
        maxResults: 1,
        nextPageToken: String(v(ctx, 'search.token')),
        fields: ['summary'],
      },
    }),
    status: 200,
    check: (body) => (list(body, 'issues').length === 1 ? null : 'expected one issue'),
  },
  {
    id: 'searchJql.invalid',
    operation: 'searchJql',
    name: 'Refuses a query that does not parse',
    request: () => ({ body: { jql: 'project = ' } }),
    status: 400,
    error: true,
  },
  {
    id: 'searchJqlGet.byKey',
    operation: 'searchJqlGet',
    name: 'Searches with the query in the address',
    needs: ['issue.key'],
    request: (ctx) => ({ query: { jql: `key = ${v(ctx, 'issue.key')}` } }),
    status: 200,
    check: (body, ctx) => includes(list(body, 'issues'), 'key', v(ctx, 'issue.key'), 'issues'),
  },
  {
    id: 'searchLegacy.total',
    operation: 'searchLegacy',
    name: 'Answers by offset with the total',
    request: (ctx) => ({
      query: { jql: `project = ${ctx.project} AND labels = contract`, maxResults: '1' },
    }),
    status: 200,
    check: (body) =>
      expectEqual(at(body, 'total'), 2, 'total') ??
      expectEqual(list(body, 'issues').length, 1, 'issues on the page'),
  },
  {
    id: 'searchLegacyPost.offset',
    operation: 'searchLegacyPost',
    name: 'Starts at an offset',
    request: (ctx) => ({
      body: { jql: `project = ${ctx.project} AND labels = contract`, startAt: 1, maxResults: 5 },
    }),
    status: 200,
    check: (body) =>
      expectEqual(at(body, 'startAt'), 1, 'startAt') ??
      expectEqual(list(body, 'issues').length, 1, 'issues on the page'),
  },

  // Bulk.
  {
    id: 'createIssues.two',
    operation: 'createIssues',
    name: 'Creates two issues in one call',
    request: (ctx) => ({
      body: {
        issueUpdates: [createBody(ctx, 'Bulk one'), createBody(ctx, 'Bulk two')].map((b) => ({
          fields: { ...b.fields, labels: ['contract-bulk'] },
        })),
      },
    }),
    status: 201,
    check: (body) =>
      expectEqual(list(body, 'issues').length, 2, 'created') ??
      expectEqual(list(body, 'errors').length, 0, 'errors'),
    capture: (body, ctx) => {
      const keys = list(body, 'issues').map((i) => String(at(i, 'key')));
      ctx.vars.set('bulk.keys', keys.join(','));
    },
  },
  {
    id: 'bulkFetchIssues.someMissing',
    operation: 'bulkFetchIssues',
    name: 'Reads the issues it finds and reports the one it does not',
    needs: ['issue.key', 'issue2.key'],
    request: (ctx) => ({
      body: {
        issueIdsOrKeys: [v(ctx, 'issue.key'), v(ctx, 'issue2.key'), `${ctx.project}-999999`],
      },
    }),
    status: 200,
    check: (body) =>
      expectEqual(list(body, 'issues').length, 2, 'issues') ??
      expectEqual(list(body, 'issueErrors').length, 1, 'issueErrors'),
  },
  {
    id: 'bulkTransition.task',
    operation: 'bulkTransition',
    name: 'Starts a task that runs a transition on the bulk issues',
    needs: ['bulk.keys', 'transition.id'],
    request: (ctx) => ({
      body: {
        bulkTransitionInputs: [
          {
            selectedIssueIdsOrKeys: String(v(ctx, 'bulk.keys')).split(','),
            transitionId: String(v(ctx, 'transition.id')),
          },
        ],
      },
    }),
    status: 201,
    capture: (body, ctx) => ctx.vars.set('bulk.task', String(at(body, 'taskId'))),
  },
  {
    id: 'bulkProgress.task',
    operation: 'bulkProgress',
    name: 'Reports the task’s progress',
    needs: ['bulk.task'],
    request: (ctx) => ({ params: { taskId: v(ctx, 'bulk.task') } }),
    status: 200,
  },
  {
    id: 'bulkEditFields.labels',
    operation: 'bulkEditFields',
    name: 'Starts a task that adds a label to the bulk issues',
    needs: ['bulk.keys'],
    request: (ctx) => ({
      body: {
        selectedIssueIdsOrKeys: String(v(ctx, 'bulk.keys')).split(','),
        selectedActions: ['labels'],
        editedFieldsInput: {
          labelsFields: [
            {
              fieldId: 'labels',
              bulkEditMultiSelectFieldOption: 'ADD',
              labels: [{ name: 'edited' }],
            },
          ],
        },
      },
    }),
    status: 201,
  },
  {
    id: 'bulkDelete.task',
    operation: 'bulkDelete',
    name: 'Starts a task that deletes the bulk issues',
    needs: ['bulk.keys'],
    request: (ctx) => ({
      body: { selectedIssueIdsOrKeys: String(v(ctx, 'bulk.keys')).split(',') },
    }),
    status: 201,
  },

  // Projects.
  {
    id: 'getProject.byKey',
    operation: 'getProject',
    name: 'Reads the project by key',
    request: (ctx) => ({ params: { projectIdOrKey: ctx.project } }),
    status: 200,
    check: (body, ctx) => expectEqual(at(body, 'key'), ctx.project, 'key'),
    capture: (body, ctx) => ctx.vars.set('project.id', String(at(body, 'id'))),
  },
  {
    id: 'getProject.unknown',
    operation: 'getProject',
    name: 'Answers 404 for a project that does not exist',
    request: () => ({ params: { projectIdOrKey: 'NOSUCHPROJECT' } }),
    status: 404,
    error: true,
  },
  {
    id: 'searchProjects.includes',
    operation: 'searchProjects',
    name: 'Lists the project',
    request: () => ({ query: { maxResults: '50' } }),
    status: 200,
    check: (body, ctx) => includes(list(body, 'values'), 'key', ctx.project, 'projects'),
  },
  {
    id: 'getProjects.includes',
    operation: 'getProjects',
    name: 'Lists the project in the older single list',
    request: () => ({}),
    status: 200,
    check: (body, ctx) => includes(list(body), 'key', ctx.project, 'projects'),
  },
  {
    id: 'getProjectComponents.list',
    operation: 'getProjectComponents',
    name: 'Answers the components, even none',
    request: (ctx) => ({ params: { projectIdOrKey: ctx.project } }),
    status: 200,
  },
  {
    id: 'createVersion.new',
    operation: 'createVersion',
    name: 'Creates a version in the project',
    needs: ['project.id'],
    request: (ctx) => ({
      body: { name: `Contract ${ctx.version}.0`, projectId: Number(v(ctx, 'project.id')) },
    }),
    status: 201,
    check: (body) => expectEqual(at(body, 'released'), false, 'released'),
  },
  {
    id: 'getProjectVersions.includes',
    operation: 'getProjectVersions',
    name: 'Lists the new version',
    request: (ctx) => ({ params: { projectIdOrKey: ctx.project } }),
    status: 200,
    check: (body, ctx) => includes(list(body), 'name', `Contract ${ctx.version}.0`, 'versions'),
  },
  {
    id: 'getProjectRoles.some',
    operation: 'getProjectRoles',
    name: 'Names the project’s roles',
    request: (ctx) => ({ params: { projectIdOrKey: ctx.project } }),
    status: 200,
    check: (body) =>
      body && typeof body === 'object' && Object.keys(body).length > 0 ? null : 'no roles',
  },

  // Configuration.
  {
    id: 'getFields.summary',
    operation: 'getFields',
    name: 'Lists the summary among the fields',
    request: () => ({}),
    status: 200,
    check: (body) => includes(list(body), 'id', 'summary', 'fields'),
  },
  {
    id: 'getIssueTypes.includes',
    operation: 'getIssueTypes',
    name: 'Lists the issue type the suite uses',
    request: () => ({}),
    status: 200,
    check: (body, ctx) => includes(list(body), 'name', ctx.issueType, 'issue types'),
  },
  {
    id: 'getPriorities.some',
    operation: 'getPriorities',
    name: 'Lists priorities',
    request: () => ({}),
    status: 200,
    check: (body) => (list(body).length > 0 ? null : 'none'),
  },
  {
    id: 'getResolutions.some',
    operation: 'getResolutions',
    name: 'Lists resolutions',
    request: () => ({}),
    status: 200,
    check: (body) => (list(body).length > 0 ? null : 'none'),
  },
  {
    id: 'getStatuses.categories',
    operation: 'getStatuses',
    name: 'Lists statuses with the three category keys',
    request: () => ({}),
    status: 200,
    check: (body) => {
      const keys = new Set(list(body).map((st) => at(st, 'statusCategory.key')));
      return ['new', 'indeterminate', 'done'].every((k) => keys.has(k))
        ? null
        : `categories ${[...keys].join(', ')}`;
    },
  },
  {
    id: 'getLinkTypes.blocks',
    operation: 'getLinkTypes',
    name: 'Lists the Blocks link type',
    request: () => ({}),
    status: 200,
    check: (body) => includes(list(body, 'issueLinkTypes'), 'name', 'Blocks', 'link types'),
  },

  // Filters and dashboards.
  {
    id: 'createFilter.basic',
    operation: 'createFilter',
    name: 'Saves a filter',
    request: (ctx) => ({
      body: { name: `Contract filter v${ctx.version}`, jql: `project = ${ctx.project}` },
    }),
    status: 200,
    capture: (body, ctx) => ctx.vars.set('filter.id', String(at(body, 'id'))),
  },
  {
    id: 'getFilter.jql',
    operation: 'getFilter',
    name: 'Reads the filter’s query back',
    needs: ['filter.id'],
    request: (ctx) => ({ params: { id: v(ctx, 'filter.id') } }),
    status: 200,
    check: (body, ctx) => (String(at(body, 'jql')).includes(ctx.project) ? null : 'query not kept'),
  },
  {
    id: 'getFavouriteFilters.list',
    operation: 'getFavouriteFilters',
    name: 'Answers the favourites, even none',
    request: () => ({}),
    status: 200,
  },
  {
    id: 'getDashboards.page',
    operation: 'getDashboards',
    name: 'Answers a page of dashboards',
    request: () => ({}),
    status: 200,
  },

  // Webhooks.
  {
    id: 'registerWebhook.basic',
    operation: 'registerWebhook',
    name: 'Registers a webhook for created issues',
    request: () => ({
      body: {
        name: 'Contract webhook',
        url: 'https://hooks.example.com/contract',
        events: ['jira:issue_created'],
      },
    }),
    status: 201,
  },
  {
    id: 'listWebhooks.includes',
    operation: 'listWebhooks',
    name: 'Lists it',
    request: () => ({}),
    status: 200,
    check: (body) => includes(list(body), 'name', 'Contract webhook', 'webhooks'),
  },

  // Agile.
  {
    id: 'getBoards.includes',
    operation: 'getBoards',
    name: 'Lists the board',
    needs: ['board'],
    request: () => ({}),
    status: 200,
    check: (body, ctx) => includes(list(body, 'values'), 'id', ctx.boardId, 'boards'),
  },
  {
    id: 'getBoard.scrum',
    operation: 'getBoard',
    name: 'Reads the board as a Scrum board',
    needs: ['board'],
    request: (ctx) => ({ params: { boardId: ctx.boardId ?? 0 } }),
    status: 200,
    check: (body) => expectEqual(at(body, 'type'), 'scrum', 'type'),
  },
  {
    id: 'getBoardConfiguration.columns',
    operation: 'getBoardConfiguration',
    name: 'Has columns with statuses',
    needs: ['board'],
    request: (ctx) => ({ params: { boardId: ctx.boardId ?? 0 } }),
    status: 200,
    check: (body) => (list(body, 'columnConfig.columns').length > 0 ? null : 'no columns'),
  },
  {
    id: 'createSprint.future',
    operation: 'createSprint',
    name: 'Creates a future sprint',
    needs: ['board'],
    request: (ctx) => ({ body: { name: 'Contract sprint', originBoardId: ctx.boardId } }),
    status: 201,
    check: (body) => expectEqual(at(body, 'state'), 'future', 'state'),
    capture: (body, ctx) => ctx.vars.set('sprint.id', Number(at(body, 'id'))),
  },
  {
    id: 'getSprint.future',
    operation: 'getSprint',
    name: 'Reads it back',
    needs: ['sprint.id'],
    request: (ctx) => ({ params: { sprintId: v(ctx, 'sprint.id') } }),
    status: 200,
    check: (body) => expectEqual(at(body, 'name'), 'Contract sprint', 'name'),
  },
  {
    id: 'moveToSprint.issue',
    operation: 'moveToSprint',
    name: 'Puts the first issue in the sprint',
    needs: ['sprint.id', 'issue.key'],
    request: (ctx) => ({
      params: { sprintId: v(ctx, 'sprint.id') },
      body: { issues: [v(ctx, 'issue.key')] },
    }),
    status: 204,
  },
  {
    id: 'getSprintIssues.includes',
    operation: 'getSprintIssues',
    name: 'Lists it in the sprint',
    needs: ['sprint.id', 'issue.key'],
    request: (ctx) => ({ params: { sprintId: v(ctx, 'sprint.id') } }),
    status: 200,
    check: (body, ctx) => includes(list(body, 'issues'), 'key', v(ctx, 'issue.key'), 'issues'),
  },
  {
    id: 'updateSprint.start',
    operation: 'updateSprint',
    name: 'Starts the sprint with dates',
    needs: ['sprint.id'],
    request: (ctx) => ({
      params: { sprintId: v(ctx, 'sprint.id') },
      body: {
        state: 'active',
        startDate: '2030-01-01T09:00:00.000Z',
        endDate: '2030-01-15T09:00:00.000Z',
      },
    }),
    status: 200,
    check: (body) => expectEqual(at(body, 'state'), 'active', 'state'),
  },
  {
    id: 'getBoardSprints.includes',
    operation: 'getBoardSprints',
    name: 'Lists the sprint on the board',
    needs: ['board', 'sprint.id'],
    request: (ctx) => ({ params: { boardId: ctx.boardId ?? 0 } }),
    status: 200,
    check: (body, ctx) => includes(list(body, 'values'), 'id', v(ctx, 'sprint.id'), 'sprints'),
  },
  {
    id: 'moveToBacklog.issue',
    operation: 'moveToBacklog',
    name: 'Takes the issue back to the backlog',
    needs: ['issue.key'],
    request: (ctx) => ({ body: { issues: [v(ctx, 'issue.key')] } }),
    status: 204,
  },
  {
    id: 'getBoardBacklog.includes',
    operation: 'getBoardBacklog',
    name: 'Lists it in the backlog',
    needs: ['board', 'issue.key'],
    request: (ctx) => ({ params: { boardId: ctx.boardId ?? 0 }, query: { maxResults: '200' } }),
    status: 200,
    check: (body, ctx) => includes(list(body, 'issues'), 'key', v(ctx, 'issue.key'), 'issues'),
  },
  {
    id: 'rankIssues.before',
    operation: 'rankIssues',
    name: 'Ranks the second issue before the first',
    needs: ['issue.key', 'issue2.key'],
    request: (ctx) => ({
      body: { issues: [v(ctx, 'issue2.key')], rankBeforeIssue: v(ctx, 'issue.key') },
    }),
    status: 204,
  },
  {
    id: 'getBoardIssues.includes',
    operation: 'getBoardIssues',
    name: 'Lists the issues on the board',
    needs: ['board', 'issue.key'],
    request: (ctx) => ({ params: { boardId: ctx.boardId ?? 0 }, query: { maxResults: '200' } }),
    status: 200,
    check: (body, ctx) => includes(list(body, 'issues'), 'key', v(ctx, 'issue.key'), 'issues'),
  },
  {
    id: 'getAgileIssue.byKey',
    operation: 'getAgileIssue',
    name: 'Reads the issue through the Agile API',
    needs: ['issue.key'],
    request: issue(),
    status: 200,
    check: (body, ctx) => expectEqual(at(body, 'key'), v(ctx, 'issue.key'), 'key'),
  },

  // Last: deleting.
  {
    id: 'deleteIssue.second',
    operation: 'deleteIssue',
    name: 'Deletes the second issue',
    needs: ['issue2.key'],
    request: issue('issue2'),
    status: 204,
  },
  {
    id: 'getIssue.deleted',
    operation: 'getIssue',
    name: 'Answers 404 for the deleted issue',
    needs: ['issue2.key'],
    request: issue('issue2'),
    status: 404,
    error: true,
  },
];

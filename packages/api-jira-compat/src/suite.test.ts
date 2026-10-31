import { stableJson } from '@taskmoor/testkit';
import { describe, expect, it } from 'vitest';
import { COMPAT_CASES } from './cases';
import { buildCompatOpenApi } from './openapi';
import { COMPAT_OPERATIONS, compatOperation, FAMILIES } from './operations';
import { type CompatRequest, type CompatTarget, plannedRuns, runCompatContract } from './runner';

/** Where provenance may point: Atlassian's public developer pages and knowledge base. */
const PUBLIC_SOURCES =
  /^https:\/\/(developer\.atlassian\.com|docs\.atlassian\.com|confluence\.atlassian\.com|community\.developer\.atlassian\.com)\//;

describe('the Jira-compatible API contract (M1-068)', () => {
  it('[API-014] names each operation once, with a summary and public sources', () => {
    const ids = COMPAT_OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = COMPAT_OPERATIONS.map((o) => `${o.method} ${o.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    for (const o of COMPAT_OPERATIONS) {
      expect(o.summary.length, o.id).toBeGreaterThan(5);
      expect(o.sources.length, o.id).toBeGreaterThan(0);
      for (const source of o.sources) expect(source, o.id).toMatch(PUBLIC_SOURCES);
      expect(FAMILIES).toContain(o.family);
    }
    // Every family the spec puts in M1 (02a section 1.2) has operations.
    for (const family of FAMILIES) {
      expect(
        COMPAT_OPERATIONS.some((o) => o.family === family),
        family,
      ).toBe(true);
    }
  });

  it('[API-014] gives every operation a case, and every case a known operation', () => {
    const caseIds = COMPAT_CASES.map((c) => c.id);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    for (const c of COMPAT_CASES) expect(() => compatOperation(c.operation)).not.toThrow();
    for (const o of COMPAT_OPERATIONS) {
      expect(
        COMPAT_CASES.some((c) => c.operation === o.id),
        o.id,
      ).toBe(true);
    }
    // Issues and search run on both versions; the Agile API once.
    const runs = plannedRuns();
    expect(runs.filter((r) => r.case.id === 'getIssue.byKey').map((r) => r.version)).toEqual([
      '2',
      '3',
    ]);
    expect(runs.filter((r) => r.case.id === 'getBoard.scrum').map((r) => r.version)).toEqual(['2']);
    expect(runs.length).toBeGreaterThan(150);
  });

  it('[API-001] writes its own OpenAPI document of the compatible API', async () => {
    const doc = buildCompatOpenApi();
    expect(doc.openapi).toBe('3.1.0');
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/rest/api/2/issue/{issueIdOrKey}']?.get?.operationId).toBe('getIssueV2');
    expect(paths['/rest/api/3/issue/{issueIdOrKey}']?.get?.['x-sources']).toEqual([
      'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/',
    ]);
    expect(paths['/rest/agile/1.0/board']?.get?.operationId).toBe('getBoards');
    await expect(stableJson(doc)).toMatchFileSnapshot('../../../docs/api/jira-compat/openapi.json');
  });

  it('[API-014] calls an absent API missing, and a broken one failing', async () => {
    const absent: CompatTarget = {
      project: 'CMP',
      issueType: 'Task',
      boardId: 1,
      call: async () => ({
        status: 404,
        body: { message: 'Route not found', error: 'Not Found', statusCode: 404 },
      }),
    };
    const nothing = await runCompatContract(absent);
    // What depends on an issue being made is untested; everything answered is missing.
    expect(nothing.totals.complete + nothing.totals.partial + nothing.totals.failing).toBe(0);
    expect(nothing.totals.missing + nothing.totals.untested).toBe(COMPAT_OPERATIONS.length);
    expect(nothing.operations.find((o) => o.id === 'createIssue')?.state).toBe('missing');
    expect(nothing.operations.find((o) => o.id === 'editIssue')?.state).toBe('untested');
    const broken: CompatTarget = {
      ...absent,
      call: async () => ({ status: 500, body: { errorMessages: ['boom'], errors: {} } }),
    };
    const bad = await runCompatContract(broken);
    expect(bad.operations.find((o) => o.id === 'createIssue')?.state).toBe('failing');
    expect(bad.totals.missing).toBe(0);
  });

  it('[API-014] tells complete from partial on a server that has a few operations', async () => {
    const issues = new Map<string, { id: string; key: string; summary: string }>();
    const user = { accountId: 'acc-1', displayName: 'Ada Admin', active: true };
    const fields = (i: { summary: string }) => ({
      summary: i.summary,
      status: { id: '1', name: 'New', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
      issuetype: { id: '10', name: 'Task', subtask: false },
      project: { id: '1', key: 'CMP', name: 'Compat' },
      assignee: null,
      reporter: user,
      created: '2026-10-31T00:00:00.000+0000',
      updated: '2026-10-31T00:00:00.000+0000',
      labels: ['contract'],
      description: null,
    });
    const notFound = { status: 404, body: { errorMessages: ['Not found'], errors: {} } };
    const fake: CompatTarget = {
      project: 'CMP',
      issueType: 'Task',
      call: async (r: CompatRequest) => {
        if (r.method === 'GET' && /\/myself$/.test(r.path)) return { status: 200, body: user };
        if (r.method === 'GET' && /\/serverInfo$/.test(r.path)) {
          return {
            status: 200,
            body: { baseUrl: 'https://t.example', version: '1.0', deploymentType: 'Server' },
          };
        }
        if (r.method === 'POST' && /\/rest\/api\/\d\/issue$/.test(r.path)) {
          const body = r.body as { fields: { summary?: string } };
          if (!body.fields.summary) {
            return {
              status: 400,
              body: { errorMessages: [], errors: { summary: 'Summary is required' } },
            };
          }
          const n = issues.size + 1;
          const made = { id: String(n), key: `CMP-${n}`, summary: body.fields.summary };
          issues.set(made.key, made);
          issues.set(made.id, made);
          return { status: 201, body: { id: made.id, key: made.key, self: `/issue/${n}` } };
        }
        const get = /\/rest\/api\/\d\/issue\/([^/]+)$/.exec(r.path);
        if (r.method === 'GET' && get) {
          const found = issues.get(decodeURIComponent(get[1] as string));
          return found
            ? {
                status: 200,
                body: { id: found.id, key: found.key, self: '/x', fields: fields(found) },
              }
            : notFound;
        }
        return { status: 404, body: { message: 'Route not found' } };
      },
    };
    const report = await runCompatContract(fake);
    const state = (id: string) => report.operations.find((o) => o.id === id)?.state;
    expect(state('getMyself')).toBe('complete');
    expect(state('getServerInfo')).toBe('complete');
    expect(state('createIssue')).toBe('complete');
    // Read by key and id, but its description is not there and edits are not seen.
    expect(state('getIssue')).toBe('partial');
    expect(state('editIssue')).toBe('missing');
    expect(state('getBoard')).toBe('untested');
    const skipped = report.cases.find((c) => c.case === 'getBoard.scrum');
    expect(skipped).toMatchObject({ outcome: 'skipped', problem: 'needs board' });
  });
});

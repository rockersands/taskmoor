import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit/golden';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import type { Manifest } from './dc-backup/manifest';
import { WorkflowCollector } from './dc-backup/stage-workflows';
import {
  actionsOf,
  isGroup,
  META,
  rulesOf,
  type WfCondition,
  type WfConditions,
  type WfDescriptor,
  writeDescriptor,
} from './dc-backup/workflow-format';
import { APP_CLASSES, CLASSES, workflowFor, workflowWorldOf } from './dc-backup/workflows';
import { buildWorld, type World, walkIssues } from './dc-backup/world';
import { mapWorkflow, mapWorkflowMap } from './dc-workflows';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.80.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/** Six projects: four on the software scheme, one on the legacy copy, one business project. */
const OPTIONS = defaultOptions(2_000, 90, { projects: 6 });
// Tickets without their content (M1-091): the workflows need tickets, not their comments or files.
const SOURCE = { format: 'dc-backup', path: 'dc-workflows.zip', scope: 'tickets' } as const;

function sessionCookie(header: string | string[] | undefined): string {
  return (
    (
      [header ?? []]
        .flat()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) ??
      ''
    ).split(';')[0] ?? ''
  );
}

/**
 * The Data Center backup import of workflows and workflow schemes (M1-090; IMP-004, IMP-005,
 * IMP-010; WF-001, WF-003, WF-006, WF-007, WF-011): each workflow becomes a published
 * workflow with its statuses, transitions (global, shared and per step), layouts, guards,
 * checks, effects, properties, events and per-status permissions; identical workflows and
 * schemes merge; every rule that cannot map is listed in the fidelity report; and an imported
 * ticket moves through its imported workflow, refused where a mapped guard says no.
 */
describe('Data Center backup import: workflows and workflow maps (M1-090)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  let manifest: Manifest;
  let world: World;
  let cookie = '';
  let report: FidelityReport;

  const as = (options: InjectOptions, session = cookie) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: session },
    });
  const entity = (kind: string) => report.entities.find((e) => e.kind === kind);

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-workflows-'));
    ({ manifest } = await generateDcBackup(OPTIONS, join(importDir, SOURCE.path)));
    world = buildWorld(OPTIONS);
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-workflows-test');
    registerImportJobs(runner, database.db, new FieldCatalogs(database.db), { batch: 100 });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    cookie = sessionCookie(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'admin@example.com', password: PASSWORD },
          remoteAddress: nextAddress(),
        })
      ).headers['set-cookie'],
    );
    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Workflows', dryRun: false, source: SOURCE },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json().importRun as { id: number };
    for (let i = 0; i < 1000; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
    const view = (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}` })).json()
      .importRun as { status: string; lastError: string | null };
    expect(view.status, view.lastError ?? '').toBe('done');
    report = fidelityReport.parse(
      (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}/report` })).json().report,
    );
  }, 600_000);
  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  /** Names for the target's ids, so the goldens read without them. */
  async function names() {
    const db = database.db;
    const pairs = async (table: 'status' | 'role' | 'user_group' | 'ticket_type' | 'workflow') =>
      new Map(
        (await db.selectFrom(table).select(['id', 'name']).execute()).map((r) => [
          String(r.id),
          r.name,
        ]),
      );
    const [statuses, roles, groups, types, workflows] = await Promise.all([
      pairs('status'),
      pairs('role'),
      pairs('user_group'),
      pairs('ticket_type'),
      pairs('workflow'),
    ]);
    return { statuses, roles, groups, types, workflows };
  }

  /** A definition with names for ids: statuses, roles and groups. */
  function named(definition: Record<string, unknown>, n: Awaited<ReturnType<typeof names>>) {
    const status = (id: unknown) => n.statuses.get(String(id)) ?? `?${id}`;
    const walk = (v: unknown, key = ''): unknown => {
      if (Array.isArray(v)) return v.map((x) => walk(x, key));
      if (v === null || typeof v !== 'object') {
        if (['to', 'initialStatusId', 'statusId', 'status'].includes(key)) return status(v);
        if (key === 'from' && typeof v === 'number') return status(v);
        if (key === 'statuses' && typeof v === 'string') return status(v);
        if (key === 'group' || key === 'groups') return `group:${n.groups.get(String(v)) ?? v}`;
        if (key === 'role' || key === 'roles') return `role:${n.roles.get(String(v)) ?? v}`;
        return v;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[key === 'statusPermissions' ? status(k) : k] = walk(x, k);
      }
      return out;
    };
    return walk(definition);
  }

  it('[IMP-004] [IMP-005] [WF-001] [WF-011] maps workflows, published, and workflow maps per track', async () => {
    const ww = workflowWorldOf(world);
    expect(report.failures).toEqual([]);
    expect(entity('workflow')?.source).toBe(manifest.entities.Workflow);
    // The copy merges into the workflow it repeats, and so does the scheme that used it.
    expect(entity('workflow')?.outcomes).toMatchObject({ created: 5, skipped: 1, failed: 0 });
    expect(entity('workflow_map')?.outcomes).toMatchObject({ created: 2, skipped: 1, failed: 0 });
    expect(report.mapping.find((m) => m.label === 'Delivery flow (copy)')).toMatchObject({
      kind: 'workflow',
      outcome: 'skipped',
      reason: 'merged_identical',
      warnings: ['merged_into: Delivery flow'],
    });
    expect(report.mapping.find((m) => m.label === 'Legacy software workflows')).toMatchObject({
      kind: 'workflow_map',
      outcome: 'skipped',
      reason: 'merged_identical',
      warnings: ['merged_into: Software workflows'],
    });
    // The statuses the workflows hold are not reported as left out of every workflow.
    expect(report.warnings.filter((w) => w.code === 'status_not_in_workflow')).toEqual([]);

    const db = database.db;
    const n = await names();
    const workflows = await db
      .selectFrom('workflow as w')
      .innerJoin('workflow_version as v', (j) =>
        j.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.published_version'),
      )
      .select([
        'w.id',
        'w.name',
        'w.description',
        'w.published_version',
        'w.draft_version',
        'v.definition',
        'v.published_at',
      ])
      .where('w.is_default', '=', false)
      .orderBy('w.name')
      .execute();
    expect(workflows.map((w) => w.name)).toEqual([
      'Archived flow',
      'Business flow',
      'Defect flow',
      'Delivery flow',
      'Step flow',
    ]);
    for (const w of workflows) {
      // Published as version 1, with no draft.
      expect([w.published_version, w.draft_version, w.published_at !== null], w.name).toEqual([
        1,
        null,
        true,
      ]);
    }
    const maps = await db
      .selectFrom('workflow_map')
      .selectAll()
      .where('is_default', '=', false)
      .orderBy('name')
      .execute();
    const entries = await db.selectFrom('workflow_map_entry').selectAll().execute();
    const tracks = await db.selectFrom('track').select(['id', 'key', 'workflow_map_id']).execute();
    await expect(
      stableJson({
        workflows: workflows.map((w) => ({
          name: w.name,
          description: w.description,
          definition: named(w.definition as Record<string, unknown>, n),
        })),
        maps: maps.map((m) => ({
          name: m.name,
          default: n.workflows.get(String(m.default_workflow_id)),
          entries: entries
            .filter((e) => e.map_id === m.id)
            .map(
              (e) =>
                `${n.types.get(String(e.ticket_type_id))} -> ${n.workflows.get(String(e.workflow_id))}`,
            )
            .sort(),
          tracks: tracks
            .filter((t) => t.workflow_map_id === m.id)
            .map((t) => t.key)
            .sort(),
        })),
      }),
    ).toMatchFileSnapshot('./__golden__/dc-workflows-seed90.workflows.json');

    // Every ticket's workflow is the one its project's scheme gives its type (the copy's
    // projects get the workflow it repeats), and its status is a step of it.
    const tickets = await db
      .selectFrom('ticket as t')
      .innerJoin('track as k', 'k.id', 't.track_id')
      .select([
        'k.key',
        't.number',
        't.status_id',
        sql<number>`ticket_workflow_id(t.workspace_id, t.track_id, t.ticket_type_id)`.as(
          'workflow_id',
        ),
      ])
      .execute();
    expect(tickets.length).toBe(OPTIONS.issues);
    const byKey = new Map(tickets.map((t) => [`${t.key}-${t.number}`, t]));
    const statusesOf = new Map(
      workflows.map((w) => [
        w.id,
        new Set(
          (w.definition as { statuses: { statusId: number }[] }).statuses.map((s) => s.statusId),
        ),
      ]),
    );
    let checked = 0;
    for (const issue of walkIssues(world)) {
      const t = byKey.get(issue.key);
      const expected = workflowFor(ww, issue.project.id, issue.type.id).name.replace(' (copy)', '');
      expect(n.workflows.get(String(t?.workflow_id)), issue.key).toBe(expected);
      expect(statusesOf.get(t?.workflow_id as number)?.has(t?.status_id as number), issue.key).toBe(
        true,
      );
      checked++;
    }
    expect(checked).toBe(OPTIONS.issues);

    // The custom event a transition fires reaches the notification policy that names it.
    const custom = await db
      .selectFrom('notification_rule')
      .select('event')
      .where('event', 'like', 'custom:%')
      .execute();
    expect(custom.map((r) => r.event)).toContain('custom:escalated');
  });

  /**
   * What the fixture says each rule should become, worked out here from the fixture alone:
   * the classes Taskmoor maps (with arguments it can keep), and everything else listed.
   */
  function expectedUnmapped(): { code: string; detail: string }[] {
    const ww = workflowWorldOf(world);
    const out: { code: string; detail: string }[] = [];
    const mappedConditions = new Set<string>([
      CLASSES.onlyAssignee,
      CLASSES.onlyReporter,
      CLASSES.alwaysFalse,
      CLASSES.permission,
      CLASSES.subtaskBlocking,
      CLASSES.inGroup,
      CLASSES.inRole,
      CLASSES.inAnyRole,
    ]);
    const mappedValidators = new Set<string>([
      CLASSES.permissionValidator,
      CLASSES.userPermissionValidator,
    ]);
    const essentials = new Set<string>([
      CLASSES.updateStatus,
      CLASSES.createComment,
      CLASSES.history,
      CLASSES.reindex,
      CLASSES.fireEvent,
      CLASSES.create,
    ]);
    const mappedFunctions = new Set<string>([
      CLASSES.assignToCurrentUser,
      CLASSES.assignToLead,
      CLASSES.assignToReporter,
    ]);
    const leaves = function* (c: WfConditions | null): Generator<WfCondition> {
      for (const item of c?.items ?? []) {
        if (isGroup(item)) yield* leaves(item);
        else yield item;
      }
    };
    const seen = new Set<string>();
    for (const w of ww.workflows) {
      const print = JSON.stringify({ ...w.descriptor, meta: {} });
      if (seen.has(print)) continue;
      seen.add(print);
      const d: WfDescriptor = w.descriptor;
      for (const { action, place } of actionsOf(d)) {
        const where = `${w.name}: ${action.name} (${action.id})`;
        if (place === 'initial') {
          for (const v of action.validators) {
            if (v.args.permissionKey !== 'CREATE_ISSUES')
              out.push({ code: 'create_check_not_mapped', detail: `${where}: ${v.className}` });
          }
          continue;
        }
        for (const c of leaves(action.conditions)) {
          if (!mappedConditions.has(c.className ?? '') || c.negate) {
            out.push({ code: 'condition_not_mapped', detail: `${where}: ${c.className}` });
          }
        }
        for (const v of action.validators) {
          if (!mappedValidators.has(v.className ?? ''))
            out.push({ code: 'check_not_mapped', detail: `${where}: ${v.className}` });
        }
        for (const r of action.conditionalResults) {
          out.push({ code: 'conditional_result_not_mapped', detail: where });
          expect(r.conditions).not.toBeNull();
        }
        for (const f of action.result?.postFunctions ?? []) {
          const name = f.className ?? `script:${f.type}`;
          if (essentials.has(name) || mappedFunctions.has(name)) continue;
          // Updating a field maps when it clears it, not when it sets another object.
          if (name === CLASSES.updateField && f.args['field.value'] === '') continue;
          out.push({ code: 'effect_not_mapped', detail: `${where}: ${name}` });
        }
      }
      for (const s of d.steps) {
        for (const key of Object.keys(s.meta)) {
          if (key === META.status || key === META.editable) continue;
          if (
            /^jira\.permission\.(edit|comment|attach|assign|transition)\.(group|projectrole)/.test(
              key,
            )
          )
            continue;
          out.push({ code: 'status_property_not_mapped', detail: `${w.name}: ${s.name}: ${key}` });
        }
      }
    }
    return out;
  }

  it('[IMP-005] [IMP-010] [WF-011] lists every rule it could not map in the fidelity report', async () => {
    const listed = report.warnings.filter((w) => w.kind === 'workflow');
    const expected = expectedUnmapped();
    expect(expected.length).toBeGreaterThan(10);
    for (const e of expected) {
      expect(
        listed.some((w) => w.code === e.code && (w.detail ?? '').startsWith(e.detail)),
        `${e.code} ${e.detail}`,
      ).toBe(true);
    }
    // And nothing else of those kinds: each listed rule is one the fixture expects.
    const ruleCodes = new Set(expected.map((e) => e.code));
    expect(listed.filter((w) => ruleCodes.has(w.code)).length).toBe(expected.length);
    // An app's or script's post function stays as a disabled placeholder with its class.
    const delivery = await database.db
      .selectFrom('workflow as w')
      .innerJoin('workflow_version as v', 'v.workflow_id', 'w.id')
      .select('v.definition')
      .where('w.name', '=', 'Delivery flow')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(delivery.definition)).toContain(
      JSON.stringify({ type: 'placeholder', jiraClass: APP_CLASSES.exportToSheet }),
    );

    const kinds = ['workflow', 'workflow_map'];
    await expect(
      stableJson({
        entities: report.entities
          .filter((e) => kinds.includes(e.kind))
          .map((e) => ({ kind: e.kind, source: e.source, outcomes: e.outcomes })),
        warnings: report.warnings
          .filter((w) => kinds.includes(w.kind))
          .map((w) => ({ kind: w.kind, code: w.code, detail: w.detail, count: w.count })),
        mapping: report.mapping
          .filter((m) => kinds.includes(m.kind))
          .map(({ targetId: _, ...m }) => m),
        unsupported: report.unsupported,
      }),
    ).toMatchFileSnapshot('./__golden__/dc-workflows-seed90.report.json');
  });

  it('[WF-001] [WF-003] [WF-007] an imported ticket takes a transition its workflow allows and is refused where a guard says no', async () => {
    const db = database.db;
    const n = await names();
    const statusId = (name: string) => Number([...n.statuses].find(([, v]) => v === name)?.[0]);
    const ww = workflowWorldOf(world);
    const admin = await db
      .selectFrom('app_user')
      .select('id')
      .where('email', '=', 'admin@example.com')
      .executeTakeFirstOrThrow();
    /** An imported ticket of the delivery flow in a status, assigned to someone else. */
    const ticketIn = async (status: string) => {
      for (const issue of walkIssues(world)) {
        if (workflowFor(ww, issue.project.id, issue.type.id).name !== 'Delivery flow') continue;
        if (issue.status.name !== status || issue.assignee === null || issue.parent !== null)
          continue;
        const row = await db
          .selectFrom('ticket as t')
          .innerJoin('track as k', 'k.id', 't.track_id')
          .select(['t.id', 't.status_id', 't.assignee_id', 't.visibility_level_id'])
          .where('k.key', '=', issue.project.key)
          .where('t.number', '=', issue.number)
          .executeTakeFirstOrThrow();
        // Visibility levels apply to site administrators too (ADR-090): one without a level.
        if (
          row.assignee_id !== null &&
          row.assignee_id !== admin.id &&
          row.visibility_level_id === null
        )
          return { key: issue.key, ...row };
      }
      throw new Error(`no ticket in ${status}`);
    };
    const offered = async (key: string) => {
      const res = await as({ method: 'GET', url: `/api/v1/tickets/${key}/transitions` });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().transitions as { name: string }[]).map((t) => t.name);
    };
    const move = (key: string, transitionId: number, fields?: Record<string, unknown>) =>
      as({
        method: 'POST',
        url: `/api/v1/tickets/${key}/transitions`,
        payload: { transitionId, ...(fields ? { fields } : {}) },
      });

    // Allowed: "Start work" from Selected, which assigns the ticket to whoever starts it.
    const selected = await ticketIn('Selected');
    expect(selected.status_id).toBe(statusId('Selected'));
    expect(await offered(selected.key)).toEqual(expect.arrayContaining(['Start work', 'Decline']));
    // Held closed: the retired path (always false) and the app's business-hours condition.
    expect(await offered(selected.key)).not.toContain('Retire path');
    expect(await offered(selected.key)).not.toContain('Escalate');
    const started = await move(selected.key, 21);
    expect(started.statusCode, started.body).toBe(200);
    const after = await db
      .selectFrom('ticket')
      .select(['status_id', 'assignee_id'])
      .where('id', '=', selected.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status_id: statusId('Working'), assignee_id: admin.id });

    // Refused: "Send to review" is only for the assignee, and this ticket is someone else's.
    const working = await ticketIn('Working');
    expect(await offered(working.key)).not.toContain('Send to review');
    const refused = await move(working.key, 31);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'transition_refused',
      by: 'guard',
      name: 'only-assignee',
    });
    // The ticket that started work is the admin's now, so it may go to review.
    expect((await move(selected.key, 31)).statusCode).toBe(200);
    const escalate = await move(selected.key, 62);
    expect(escalate.json()).toMatchObject({
      error: 'transition_refused',
      by: 'guard',
      name: 'always-false',
    });

    // Finished is not editable in the source: nobody edits a finished ticket (WF-007).
    const finished = await ticketIn('Finished');
    const edit = await as({
      method: 'PATCH',
      url: `/api/v1/tickets/${finished.key}`,
      payload: { summary: 'Edited after the fact' },
    });
    expect(edit.statusCode, edit.body).toBe(403);
  });

  it('[IMP-004] [WF-011] the format layer: descriptors read back as written, and the built-in workflow links to the default', () => {
    const ww = workflowWorldOf(world);
    const collector = new WorkflowCollector();
    for (const w of ww.workflows.slice(0, 2)) {
      collector.row('Workflow', {
        id: String(w.id),
        name: w.name,
        descriptor: writeDescriptor(w.descriptor),
      });
    }
    collector.row('WorkflowScheme', { id: '1', name: 'Only the built-in', description: '' });
    collector.row('WorkflowSchemeEntity', {
      id: '1',
      scheme: '1',
      workflow: 'Defect flow',
      issuetype: '10001',
    });
    collector.row('WorkflowSchemeEntity', {
      id: '2',
      scheme: '1',
      workflow: 'Gone flow',
      issuetype: '0',
    });
    collector.row('WorkflowSchemeEntity', {
      id: '3',
      scheme: '1',
      workflow: 'Delivery flow',
      issuetype: '99',
    });
    const statuses = new Set(world.statuses.map((s) => String(s.id)));
    const { workflow, workflow_map } = collector.resolve(
      new Set(['10000']),
      new Map([['WorkflowScheme', new Map([['1', ['10000']]])]]),
      {
        statuses,
        types: new Set(world.issueTypes.map((t) => String(t.id))),
        roles: new Set(world.roles.map((r) => String(r.id))),
        group: (raw) => raw.toLowerCase(),
        screen: () => null,
      },
    );
    // The descriptor reads back into the model it was written from.
    expect(workflow.find((w) => w.id === String(ww.workflows[0]?.id))?.data.descriptor).toEqual(
      JSON.parse(JSON.stringify(ww.workflows[0]?.descriptor)),
    );
    // A scheme with no default entity of a workflow the backup holds uses the built-in one,
    // which links to the target's default; the entities that name nothing are reported.
    const scheme = workflow_map[0]?.data;
    expect(scheme).toMatchObject({
      defaultWorkflow: 'jira',
      entries: [{ type: '10001', workflow: '10001' }],
    });
    expect(mapWorkflowMap(scheme as NonNullable<typeof scheme>).warnings).toEqual([
      { code: 'workflow_not_found', detail: 'Gone flow' },
      { code: 'issue_type_not_found', detail: '99' },
    ]);
    const system = workflow.find((w) => w.id === 'jira')?.data;
    expect(system ? mapWorkflow(system) : null).toMatchObject({
      command: { kind: 'workflow', isDefault: true },
      warnings: [{ code: 'system_workflow_linked_to_default' }],
    });
    // Every rule of the fixture is one the walker sees.
    const rules = ww.workflows.flatMap((w) =>
      [...actionsOf(w.descriptor)].flatMap(({ action }) => [...rulesOf(action)]),
    );
    expect(rules.length).toBeGreaterThan(100);
  });
});

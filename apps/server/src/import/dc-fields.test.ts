import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit/golden';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { JobRunner } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { checkRichText } from '../tickets/model';
import { type CustomValue, customValues, type FieldDef, fieldWorldOf } from './dc-backup/fields';
import { defaultOptions, generateDcBackup } from './dc-backup/generate';
import type { Manifest } from './dc-backup/manifest';
import { buildWorld, type World, walkIssues } from './dc-backup/world';
import { registerImportJobs } from './jobs';
import { type FidelityReport, fidelityReport } from './report';

// Made at run time: tests keep no credentials in the repository.
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.77.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/** Six projects, so one is a business project and one keeps the default field rules. */
const OPTIONS = defaultOptions(4_000, 89, { projects: 6 });
const SOURCE = { format: 'dc-backup', path: 'dc-fields.zip' } as const;

/** The share of custom values that must arrive exactly (M1-089's done-when). */
const MATCH_RATE = 0.999;

/**
 * The Data Center backup import of custom fields and forms (M1-089; IMP-001, IMP-004, IMP-010;
 * CORE-003, CORE-010, CORE-013): a seeded synthetic backup with every built-in custom field
 * type, an app's field, contexts per project and type, options with defaults, field
 * configurations and screens imports through the route and the job; its fields, contexts,
 * options, field rule sets and layout sets match the fixture, and every custom value of every
 * ticket is compared with the value the fixture's instance gives it.
 */
describe('Data Center backup import: custom fields and forms (M1-089)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let runner: JobRunner;
  let importDir = '';
  let manifest: Manifest;
  let world: World;
  let cookie = '';
  let report: FidelityReport;

  const as = (options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
  const entity = (kind: string) => report.entities.find((e) => e.kind === kind);

  /** Target ids by name: fields, contexts within a field, options within a context. */
  async function targets() {
    const db = database.db;
    const fields = await db
      .selectFrom('field')
      .select(['id', 'name', 'type', 'multiple', 'config'])
      .where('workspace_id', '=', 1)
      .execute();
    const contexts = await db.selectFrom('field_context').selectAll().execute();
    const options = await db.selectFrom('field_option').selectAll().execute();
    const field = (name: string) => {
      const f = fields.find((x) => x.name === name);
      if (!f) throw new Error(`no field ${name}`);
      return f;
    };
    const context = (f: FieldDef, name: string) => {
      const c = contexts.find((x) => x.field_id === field(f.name).id && x.name === name);
      if (!c) throw new Error(`no context ${name}`);
      return c;
    };
    // Source option id to target option id, through names only.
    const option = new Map<number, number>();
    for (const f of fieldWorldOf(world).fields) {
      if (f.kind === 'plugin') continue;
      for (const c of f.contexts) {
        const target = context(f, c.name);
        for (const o of c.options) {
          const parentValue = c.options.find((p) => p.id === o.parent)?.value ?? null;
          const parentId =
            parentValue === null
              ? null
              : options.find(
                  (x) =>
                    x.context_id === target.id && x.parent_id === null && x.value === parentValue,
                )?.id;
          const found = options.find(
            (x) =>
              x.context_id === target.id &&
              x.parent_id === (parentId ?? null) &&
              x.value === o.value,
          );
          if (found) option.set(o.id, found.id);
        }
      }
    }
    const users = new Map(
      (await db.selectFrom('app_user').select(['id', 'email']).execute()).map((u) => [
        (u.email ?? '').toLowerCase(),
        u.id,
      ]),
    );
    const groups = new Map(
      (await db.selectFrom('user_group').select(['id', 'name']).execute()).map((g) => [
        g.name.toLowerCase(),
        g.id,
      ]),
    );
    const tracks = new Map(
      (await db.selectFrom('track').select(['id', 'key']).execute()).map((t) => [t.key, t.id]),
    );
    const types = new Map(
      (await db.selectFrom('ticket_type').select(['id', 'name']).execute()).map((t) => [
        t.name,
        t.id,
      ]),
    );
    return { fields, contexts, options, field, context, option, users, groups, tracks, types };
  }

  beforeAll(async () => {
    importDir = await mkdtemp(join(tmpdir(), 'taskmoor-dc-fields-'));
    ({ manifest } = await generateDcBackup(OPTIONS, join(importDir, SOURCE.path)));
    world = buildWorld(OPTIONS);
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], importDir });
    runner = new JobRunner(database.db, 'dc-fields-test');
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    cookie = (
      [res.headers['set-cookie'] ?? []]
        .flat()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) ??
      ''
    ).split(';')[0] as string;

    const started = await as({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: { name: 'Fields', dryRun: false, source: SOURCE },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json().importRun as { id: number };
    for (let i = 0; i < 1000; i++) {
      if ((await runner.runOnce()) === 0) break;
    }
    const view = (await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}` })).json()
      .importRun as { status: string; lastError: string | null };
    expect(view.status, view.lastError ?? '').toBe('done');
    const res2 = await as({ method: 'GET', url: `/api/v1/admin/imports/${run.id}/report` });
    report = fidelityReport.parse(res2.json().report);
  }, 600_000);
  afterAll(async () => {
    await app.close();
    await rm(importDir, { recursive: true, force: true });
  });

  it('[IMP-004] [CORE-010] imports every custom field with its type, contexts, options and defaults', async () => {
    const t = await targets();
    const fw = fieldWorldOf(world);
    expect(entity('field')?.source).toBe(manifest.entities.CustomField);
    expect(entity('field')?.outcomes.created).toBe(fw.fields.length);
    expect(entity('field_context')?.outcomes.created).toBe(manifest.entities.FieldConfigScheme);
    expect(entity('field_option')?.outcomes.created).toBe(manifest.entities.CustomFieldOption);
    expect(report.failures).toEqual([]);

    const shape = (name: string) => {
      const f = t.field(name);
      return { type: f.type, multiple: f.multiple, config: f.config };
    };
    expect(Object.fromEntries(fw.fields.map((f) => [f.name, shape(f.name)]))).toEqual({
      Effort: { type: 'number', multiple: false, config: {} },
      Customer: { type: 'text', multiple: false, config: {} },
      'Steps to reproduce': { type: 'paragraph', multiple: false, config: {} },
      'Target date': { type: 'date', multiple: false, config: {} },
      'Reviewed at': { type: 'datetime', multiple: false, config: {} },
      Severity: { type: 'select', multiple: false, config: {} },
      Platforms: { type: 'select', multiple: true, config: {} },
      Channel: { type: 'select', multiple: false, config: { display: 'radio' } },
      Checks: { type: 'select', multiple: true, config: { display: 'checkboxes' } },
      Region: { type: 'cascading-select', multiple: false, config: {} },
      Reviewer: { type: 'user', multiple: false, config: {} },
      Helpers: { type: 'user', multiple: true, config: {} },
      'Owning group': { type: 'group', multiple: false, config: {} },
      Audience: { type: 'group', multiple: true, config: {} },
      Topics: { type: 'labels', multiple: false, config: {} },
      'Design link': { type: 'url', multiple: false, config: {} },
      'Legacy code': { type: 'read-only-text', multiple: false, config: {} },
      // An app's field: its raw values as read-only text (spec 02a section 3).
      Rating: { type: 'read-only-text', multiple: false, config: {} },
    });
    expect(report.warnings).toContainEqual(
      expect.objectContaining({
        kind: 'field',
        code: 'app_field_as_read_only_text',
        detail: 'com.example.ratings:stars',
      }),
    );

    // Each context applies to exactly the fixture's projects and types.
    const scopes = await database.db.selectFrom('field_context_scope').selectAll().execute();
    for (const f of fw.fields) {
      for (const c of f.contexts) {
        const target = t.context(f, c.name);
        const projects = c.projects === null ? [null] : c.projects;
        const types = c.types === null ? [null] : c.types;
        const want = projects
          .flatMap((p) =>
            types.map((ty) => {
              const key = p === null ? null : world.projects.find((x) => x.id === p)?.key;
              const name = ty === null ? null : world.issueTypes.find((x) => x.id === ty)?.name;
              return `${key ? t.tracks.get(key) : 0}:${name ? t.types.get(name) : 0}`;
            }),
          )
          .sort();
        const got = scopes
          .filter((s) => s.context_id === target.id)
          .map((s) => `${s.track_id ?? 0}:${s.ticket_type_id ?? 0}`)
          .sort();
        expect(got, `${f.name}: ${c.name}`).toEqual(want);
        // Options: values, order, disabled ones, cascading children under their parents.
        const rows = t.options.filter((o) => o.context_id === target.id);
        expect(
          rows
            .map((o) => ({
              value: o.value,
              parent: rows.find((p) => p.id === o.parent_id)?.value ?? null,
              sortOrder: o.sort_order,
              disabled: o.disabled,
            }))
            .sort(
              (a, b) => (a.parent ?? '').localeCompare(b.parent ?? '') || a.sortOrder - b.sortOrder,
            ),
          `${f.name}: ${c.name}`,
        ).toEqual(
          c.options
            .map((o) => ({
              value: o.value,
              parent: c.options.find((p) => p.id === o.parent)?.value ?? null,
              sortOrder: o.sequence,
              disabled: o.disabled,
            }))
            .sort(
              (a, b) => (a.parent ?? '').localeCompare(b.parent ?? '') || a.sortOrder - b.sortOrder,
            ),
        );
        // Defaults: an option, or a number.
        const expected =
          c.defaultOption !== null
            ? (t.option.get(c.defaultOption) ?? null)
            : c.defaultNumber !== null
              ? c.defaultNumber
              : null;
        expect(target.default_value ?? null, `${f.name}: ${c.name} default`).toEqual(expected);
      }
    }
  });

  it('[IMP-004] [CORE-013] maps field configurations to field rule sets and screens to layout sets', async () => {
    const t = await targets();
    const db = database.db;
    const ruleSets = await db.selectFrom('field_rule_set').selectAll().execute();
    const layoutSets = await db.selectFrom('layout_set').selectAll().execute();
    const tracks = await db
      .selectFrom('track')
      .select(['key', 'field_rule_set_id', 'layout_set_id'])
      .execute();
    const setName = (rows: typeof ruleSets, id: number | null) =>
      rows.find((r) => r.id === id)?.name ?? null;
    // Each track uses its project's scheme; the second project keeps the default rules.
    for (const p of world.projects) {
      const track = tracks.find((x) => x.key === p.key);
      expect(setName(ruleSets, track?.field_rule_set_id ?? null), p.key).toBe(
        p.index === 1
          ? 'Standard field rules'
          : p.type === 'software'
            ? 'Software field rules'
            : 'Business field rules',
      );
      expect(setName(layoutSets, track?.layout_set_id ?? null), p.key).toBe(
        p.type === 'software' ? 'Software screens' : 'Business screens',
      );
    }

    // The forms as the product shows them: a defect's create form in a software track uses
    // the defect screen, with its required fields and help text.
    const software = world.projects.find((p) => p.type === 'software' && p.index !== 1);
    const defect = t.types.get('Defect');
    const form = async (key: string, type: number | undefined, operation: string) => {
      const res = await as({
        method: 'GET',
        url: `/api/v1/tracks/${key}/layout?ticketTypeId=${type}&operation=${operation}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      const layout = res.json().layout as {
        tabs: {
          name: string | null;
          sections: { fields: { key: string; required: boolean; description: string | null }[] }[];
        }[];
      };
      return layout.tabs.map((tab) => ({
        name: tab.name,
        fields: tab.sections.flatMap((s) => s.fields),
      }));
    };
    const cf = (name: string) => `cf[${t.field(name).id}]`;
    const defectCreate = await form(software?.key ?? '', defect, 'create');
    expect(defectCreate.map((tab) => tab.name)).toEqual(['Fields', 'Triage']);
    const steps = defectCreate[0]?.fields.find((f) => f.key === cf('Steps to reproduce'));
    expect(steps).toEqual({
      key: cf('Steps to reproduce'),
      required: true,
      description: 'Numbered steps, please',
    });
    expect(defectCreate[0]?.fields.find((f) => f.key === 'priority')?.required).toBe(true);
    // The defect rules hide the app's field, which is on the defect screen.
    expect(defectCreate[1]?.fields.map((f) => f.key)).toEqual([cf('Reviewer'), cf('Platforms')]);
    // Other types create with the short screen, edit with the full one.
    const feature = t.types.get('Feature request');
    const quick = await form(software?.key ?? '', feature, 'create');
    expect(quick.flatMap((tab) => tab.fields.map((f) => f.key))).toEqual([
      'summary',
      'assignee',
      'description',
    ]);
    const edit = await form(software?.key ?? '', feature, 'edit');
    expect(edit.map((tab) => tab.name)).toEqual(['Fields', 'More']);
    // There, the app's field shows as read-only text.
    expect(edit[1]?.fields.map((f) => f.key)).toContain(cf('Rating'));
    expect(edit[0]?.fields.find((f) => f.key === 'description')?.description).toBe(
      'What needs doing and why',
    );
    // A business track requires the due date and hides the estimates. Its rules also require
    // the customer, but that field's only context is for software tracks: it does not apply.
    const business = world.projects.find((p) => p.type === 'business');
    const businessEdit = await form(business?.key ?? '', feature, 'edit');
    const keys = businessEdit.flatMap((tab) => tab.fields);
    expect(keys.find((f) => f.key === 'dueDate')?.required).toBe(true);
    expect(keys.map((f) => f.key)).not.toContain('originalEstimate');
    expect(keys.map((f) => f.key)).not.toContain(cf('Customer'));

    // The whole of both, by name, as a golden.
    const rules = await db.selectFrom('field_rule').selectAll().execute();
    const layouts = await db.selectFrom('layout').selectAll().execute();
    const fieldName = (key: string) => {
      const id = /^cf\[(\d+)\]$/.exec(key)?.[1];
      return id ? `cf:${t.fields.find((f) => f.id === Number(id))?.name}` : key;
    };
    const typeName = (id: number | null) =>
      id === null ? null : ([...t.types].find(([, v]) => v === id)?.[0] ?? '?');
    const used = (column: 'field_rule_set_id' | 'layout_set_id', id: number) =>
      tracks
        .filter((x) => x[column] === id)
        .map((x) => x.key)
        .sort();
    await expect(
      stableJson({
        ruleSets: ruleSets
          .filter((s) => !s.is_default)
          .map((s) => ({
            name: s.name,
            tracks: used('field_rule_set_id', s.id),
            rules: rules
              .filter((r) => r.rule_set_id === s.id)
              .map((r) => ({
                type: typeName(r.ticket_type_id),
                field: fieldName(r.field),
                required: r.required,
                hidden: r.hidden,
                description: r.description,
              }))
              .sort((a, b) => `${a.type}|${a.field}`.localeCompare(`${b.type}|${b.field}`)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        layoutSets: layoutSets
          .filter((s) => !s.is_default)
          .map((s) => ({
            name: s.name,
            tracks: used('layout_set_id', s.id),
            layouts: layouts
              .filter((l) => l.layout_set_id === s.id)
              .map((l) => {
                const d = l.definition as {
                  tabs: { name: string; sections: { fields: string[] }[] }[];
                  others: string;
                };
                return {
                  type: typeName(l.ticket_type_id),
                  operation: l.operation,
                  others: d.others,
                  tabs: d.tabs.map((tab) => ({
                    name: tab.name,
                    fields: tab.sections.flatMap((x) => x.fields.map(fieldName)),
                  })),
                };
              })
              .sort((a, b) => `${a.type}|${a.operation}`.localeCompare(`${b.type}|${b.operation}`)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }),
    ).toMatchFileSnapshot('./__golden__/dc-fields-seed89.forms.json');
  });

  it(`[IMP-004] [IMP-010] at least ${MATCH_RATE * 100}% of custom field values match the golden fixture`, async () => {
    const t = await targets();
    const fw = fieldWorldOf(world);
    const tickets = new Map(
      (
        await database.db
          .selectFrom('ticket as t')
          .innerJoin('track as k', 'k.id', 't.track_id')
          .select(['k.key', 't.number', 't.fields'])
          .execute()
      ).map((r) => [`${r.key}-${r.number}`, r.fields as Record<string, JsonValue>]),
    );
    expect(entity('ticket')?.source).toBe(manifest.entities.Issue);
    expect(entity('ticket')?.outcomes.failed).toBe(0);

    const sorted = (ids: (number | undefined)[]) => ids.map((i) => i ?? -1).sort((a, b) => a - b);
    /** What the fixture says a value is, in Taskmoor's stored form with target ids. */
    const expectedOf = (v: CustomValue): JsonValue => {
      const multiple = t.field(v.field.name).multiple;
      switch (v.kind) {
        case 'string':
          return v.values[0] as string;
        case 'text': {
          // A paragraph per block of text, in the canonical form documents are stored in.
          const doc = checkRichText({
            type: 'doc',
            content: v.text
              .split('\n\n')
              .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
          });
          return doc.ok ? doc.doc : null;
        }
        case 'number':
          return v.number;
        case 'date':
          return v.field.kind === 'datepicker'
            ? new Date(v.at).toISOString().slice(0, 10)
            : new Date(v.at).toISOString();
        case 'options': {
          const ids = sorted(v.options.map((o) => t.option.get(o)));
          return multiple ? ids : (ids[0] as number);
        }
        case 'cascade': {
          const parent = t.option.get(v.parent) ?? -1;
          return v.child === null ? [parent] : [parent, t.option.get(v.child) ?? -1];
        }
        case 'people': {
          const ids = sorted(v.people.map((p) => t.users.get(p.email.toLowerCase())));
          return multiple ? ids : (ids[0] as number);
        }
        case 'groups': {
          const ids = sorted(v.groups.map((g) => t.groups.get(g.toLowerCase())));
          return multiple ? ids : (ids[0] as number);
        }
        case 'labels':
          return v.labels;
      }
    };
    const perField: Record<string, { values: number; matched: number }> = {};
    const mismatches: { ticket: string; field: string; expected: JsonValue; actual: JsonValue }[] =
      [];
    let values = 0;
    let matched = 0;
    for (const issue of walkIssues(world)) {
      const actual = tickets.get(issue.key);
      const expected = new Map(customValues(world, issue).map((v) => [v.field.id, v]));
      for (const f of fw.fields) {
        const want = expected.get(f.id);
        const got = actual?.[String(t.field(f.name).id)];
        if (want === undefined && got === undefined) continue;
        const wanted = want === undefined ? null : expectedOf(want);
        const counts = perField[f.name] ?? { values: 0, matched: 0 };
        perField[f.name] = counts;
        values++;
        counts.values++;
        if (got !== undefined && want !== undefined && stableJson(got) === stableJson(wanted)) {
          matched++;
          counts.matched++;
        } else {
          mismatches.push({
            ticket: issue.key,
            field: f.name,
            expected: wanted,
            actual: actual === undefined ? 'no ticket' : (got ?? null),
          });
        }
      }
    }
    const rate = matched / values;
    // The values comparison, with every mismatch named, is the report of this test.
    await expect(
      stableJson({
        fixture: { issues: OPTIONS.issues, seed: OPTIONS.seed, projects: OPTIONS.projects },
        values,
        matched,
        rate: Math.floor(rate * 1e6) / 1e6,
        perField,
        mismatches,
      }),
    ).toMatchFileSnapshot('./__golden__/dc-fields-seed89.values.json');
    expect(values).toBeGreaterThan(OPTIONS.issues * 3);
    expect(Object.keys(perField).length).toBe(fw.fields.length);
    expect(rate, JSON.stringify(mismatches.slice(0, 20))).toBeGreaterThanOrEqual(MATCH_RATE);
    // The fixture's values reached the backup as rows (one per value, labels apart).
    expect(manifest.cases.customFieldValues).toBeGreaterThan(values / 2);
  });

  it('[IMP-010] reports the run: counts, outcomes, warnings and the mapping by name', async () => {
    await expect(
      stableJson({
        entities: report.entities.map((e) => ({
          kind: e.kind,
          source: e.source,
          outcomes: e.outcomes,
        })),
        unsupported: report.unsupported,
        warnings: report.warnings.map((w) => ({
          kind: w.kind,
          code: w.code,
          detail: w.detail,
          count: w.count,
        })),
        mapping: report.mapping
          .filter((m) => m.kind.startsWith('field') || m.kind === 'layout_set')
          .map(({ targetId: _, ...m }) => m),
      }),
    ).toMatchFileSnapshot('./__golden__/dc-fields-seed89.report.json');
  });
});

import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { customKey, type LayoutDefinition, layoutDefinition } from '../fields/form-model';
import {
  checkLayouts,
  checkRules,
  type LayoutInput,
  type RuleInput,
  replaceLayouts,
  replaceRules,
  type SetProblem,
} from '../fields/sets';
import {
  existingTarget,
  type LoadContext,
  type Loader,
  lower,
  optional,
  PENDING,
  PlanFailure,
} from './load';
import type { FieldRuleSetCommand, FormField, LayoutSetCommand } from './model';

/**
 * Loaders for field rule sets and layout sets (M1-089; IMP-004; ADR-089). Each links to the
 * target's shared set of the same name, which keeps its own rules and layouts as linked
 * objects do (ADR-048), or creates one; either way the command's tracks then use it. Rules and
 * layouts go through the same checks and writes as the routes (`fields/sets.ts`). A rule or a
 * layout field that names something the import did not bring (a field left out, a type that
 * failed) is dropped with a warning rather than failing the whole set.
 */
type Db = Kysely<Database> | Transaction<Database>;
type SetTable = 'field_rule_set' | 'layout_set';

/** A form field as the target names it, PENDING in a dry run, null when it did not map. */
function fieldKey(
  ctx: LoadContext,
  field: FormField,
  where: string,
  warned: Set<string>,
): string | null | 'pending' {
  if ('key' in field) return field.key;
  const id = ctx.refs.get(field.custom);
  if (id === null) {
    const detail = `${where}:${field.custom.id}`;
    if (!warned.has(detail)) ctx.warn({ code: 'form_field_not_imported', detail });
    warned.add(detail);
    return null;
  }
  return id === PENDING ? 'pending' : customKey(id);
}

const problemText = (p: SetProblem) =>
  `invalid_${String(p.body.error)}${p.body.detail ? `:${String(p.body.detail)}` : ''}`;

async function setPlan(
  ctx: LoadContext,
  table: SetTable,
  name: string,
  existing: number | null,
  data: unknown,
) {
  const fingerprint = { name: lower(name) };
  if (existing !== null) {
    await existingTarget(ctx, table, existing);
    return { action: 'update' as const, targetId: existing, fingerprint, data };
  }
  const found = await ctx.trx
    .selectFrom(table)
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('track_id', 'is', null)
    .where(sql<string>`lower(name)`, '=', lower(name))
    .executeTakeFirst();
  if (found) return { action: 'link' as const, targetId: found.id, fingerprint, data };
  return { action: 'create' as const, targetId: null, fingerprint, data };
}

/** Creates or renames the set; returns its id. A linked set is left as it is. */
async function writeSet(
  ctx: LoadContext,
  table: SetTable,
  cmd: { name: string; description: string },
  plan: { action: 'create' | 'update' | 'link'; targetId: number | null },
): Promise<number> {
  if (plan.action === 'update') {
    await ctx.trx
      .updateTable(table)
      .set({ name: cmd.name, description: cmd.description, updated_at: new Date() })
      .where('id', '=', plan.targetId as number)
      .execute();
    return plan.targetId as number;
  }
  if (plan.action === 'link') return plan.targetId as number;
  const row = await ctx.trx
    .insertInto(table)
    .values({
      workspace_id: ctx.workspaceId,
      track_id: null,
      name: cmd.name,
      description: cmd.description,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function tracksOf(ctx: LoadContext, refs: FieldRuleSetCommand['tracks']): number[] {
  return refs.flatMap((t) => {
    const id = optional(ctx, t, 'tracks');
    return id === null || id === PENDING ? [] : [id];
  });
}

const readSets = (table: SetTable) => async (db: Db, ws: number, ids: readonly number[]) => {
  const rows = await db
    .selectFrom(table)
    .select(['id', 'name'])
    .where('workspace_id', '=', ws)
    .where('id', 'in', [...ids])
    .execute();
  return new Map(rows.map((r) => [r.id, { name: lower(r.name) }]));
};

interface RuleSetData {
  rules: RuleInput[];
  tracks: number[];
}

export const fieldRuleSets: Loader<FieldRuleSetCommand> = {
  table: { name: 'field_rule_set', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(
      cmds.flatMap((c) => [
        ...c.tracks,
        ...c.rules.flatMap((r) => [
          ...(r.type ? [r.type] : []),
          ...('custom' in r.field ? [r.field.custom] : []),
        ]),
      ]),
    );
  },
  async plan(ctx, cmd, existing) {
    const rules: RuleInput[] = [];
    const warned = new Set<string>();
    let pending = false;
    for (const r of cmd.rules) {
      const type = r.type === null ? null : ctx.refs.get(r.type);
      if (type === null && r.type !== null) {
        ctx.warn({ code: 'form_type_not_imported', detail: r.type.id });
        continue;
      }
      const field = fieldKey(ctx, r.field, 'rule', warned);
      if (field === null) continue;
      if (field === 'pending' || type === PENDING) {
        pending = true;
        continue;
      }
      rules.push({
        ticketTypeId: type,
        field,
        required: r.required,
        hidden: r.hidden,
        description: r.description,
        editableBy: null,
      });
    }
    // In a dry run new fields and types have no ids yet: what can be checked, is.
    const problem = await checkRules(ctx.trx, ctx.workspaceId, ctx.catalog, null, rules);
    if (problem) throw new PlanFailure(problemText(problem));
    if (pending && !ctx.dryRun) throw new PlanFailure('missing_reference:rules');
    const data: RuleSetData = { rules, tracks: tracksOf(ctx, cmd.tracks) };
    return setPlan(ctx, 'field_rule_set', cmd.name, existing, data);
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as RuleSetData;
    const id = await writeSet(ctx, 'field_rule_set', cmd, plan);
    if (plan.action !== 'link') await replaceRules(ctx.trx, ctx.workspaceId, id, d.rules);
    if (d.tracks.length > 0) {
      await ctx.trx
        .updateTable('track')
        .set({ field_rule_set_id: id, updated_at: new Date() })
        .where('id', 'in', d.tracks)
        .execute();
    }
    return id;
  },
  read: readSets('field_rule_set'),
};

interface LayoutSetData {
  layouts: LayoutInput[];
  tracks: number[];
}

/** A layout's definition: one main section per tab, each field once, within the limits. */
function definitionOf(
  ctx: LoadContext,
  layout: LayoutSetCommand['layouts'][number],
  warned: Set<string>,
): { definition: LayoutDefinition; pending: boolean } {
  const seen = new Set<string>();
  let pending = false;
  const tabs: LayoutDefinition['tabs'] = [];
  for (const [k, tab] of layout.tabs.entries()) {
    const fields: string[] = [];
    for (const f of tab.fields) {
      const key = fieldKey(ctx, f, 'layout', warned);
      if (key === null) continue;
      if (key === 'pending') {
        pending = true;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(key);
    }
    if (k >= 20) {
      ctx.warn({ code: 'layout_tab_not_imported', detail: tab.name.slice(0, 100) });
      continue;
    }
    if (fields.length > 500)
      ctx.warn({ code: 'layout_fields_cut', detail: tab.name.slice(0, 100) });
    tabs.push({
      name: tab.name.trim().slice(0, 100) || `Tab ${k + 1}`,
      sections: [{ kind: 'main', hideWhenEmpty: false, fields: fields.slice(0, 500) }],
    });
  }
  const parsed = layoutDefinition.safeParse({ tabs, others: layout.others });
  if (!parsed.success) throw new PlanFailure('invalid_layout');
  return { definition: parsed.data, pending };
}

export const layoutSets: Loader<LayoutSetCommand> = {
  table: { name: 'layout_set', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(
      cmds.flatMap((c) => [
        ...c.tracks,
        ...c.layouts.flatMap((l) => [
          ...(l.type ? [l.type] : []),
          ...l.tabs.flatMap((t) => t.fields.flatMap((f) => ('custom' in f ? [f.custom] : []))),
        ]),
      ]),
    );
  },
  async plan(ctx, cmd, existing) {
    const layouts: LayoutInput[] = [];
    const warned = new Set<string>();
    let pending = false;
    for (const l of cmd.layouts) {
      const type = l.type === null ? null : ctx.refs.get(l.type);
      if (type === null && l.type !== null) {
        ctx.warn({ code: 'form_type_not_imported', detail: l.type.id });
        continue;
      }
      const { definition, pending: some } = definitionOf(ctx, l, warned);
      pending ||= some || type === PENDING;
      if (type === PENDING) continue;
      layouts.push({ ticketTypeId: type, operation: l.operation, definition });
    }
    const problem = await checkLayouts(ctx.trx, ctx.workspaceId, ctx.catalog, null, layouts);
    if (problem) throw new PlanFailure(problemText(problem));
    if (pending && !ctx.dryRun) throw new PlanFailure('missing_reference:layouts');
    const data: LayoutSetData = { layouts, tracks: tracksOf(ctx, cmd.tracks) };
    return setPlan(ctx, 'layout_set', cmd.name, existing, data);
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as LayoutSetData;
    const id = await writeSet(ctx, 'layout_set', cmd, plan);
    if (plan.action !== 'link') await replaceLayouts(ctx.trx, ctx.workspaceId, id, d.layouts);
    if (d.tracks.length > 0) {
      await ctx.trx
        .updateTable('track')
        .set({ layout_set_id: id, updated_at: new Date() })
        .where('id', 'in', d.tracks)
        .execute();
    }
    return id;
  },
  read: readSets('layout_set'),
};

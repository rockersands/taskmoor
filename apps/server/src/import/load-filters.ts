import type { JsonValue } from '@taskmoor/db';
import { type Query, QueryError, type Value } from '@taskmoor/query';
import { sql } from 'kysely';
import { readWidgets, type Widget, type WidgetInput } from '../dashboards/model';
import { SearchError } from '../search/bind';
import { queryCatalogue } from '../search/catalogue';
import { prepareSearch } from '../search/run';
import { nextRun } from '../search/schedule';
import {
  DASHBOARD_SHARES,
  SAVED_SEARCH_SHARES,
  type ShareInput,
  shareKey,
  sharesOf,
  writeShares,
} from '../sharing/shares';
import {
  existingTarget,
  type LoadContext,
  type Loader,
  lower,
  PENDING,
  PlanFailure,
  real,
  required,
} from './load';
import type {
  DashboardCommand,
  Ref,
  SavedSearchCommand,
  ShareCommand,
  SubscriptionCommand,
} from './model';
import { type Note, refusal, renderQuery, type SlotAs, slotsOf } from './translate/jql';

/**
 * Saved searches, search subscriptions and dashboards (M1-094; IMP-004; ADR-096), written with
 * SQL like the other loaders and kept as their routes keep them (ADR-053, ADR-060).
 *
 * A saved search's query is finished here (`translate/jql.ts`, step 2): the references the stage
 * made are resolved to the imported objects and printed, then the text is prepared as its owner
 * would run it (`prepareSearch`), so a saved search that imports clean also runs. One that cannot
 * translate, or that the target refuses, keeps its text (the source's, or the translation) and
 * the reason in `import_problem`; its owner sees why, and saving a query clears it. Names stay
 * unique per owner: a second one of a name gets " (imported)". Shares and stars that name
 * something that did not import are left out, never widened.
 */
const MAX_QUERY = 100_000;
const MAX_PROBLEM = 2_000;

/** Shares as the sharing module writes them; those whose target did not import are left out. */
function resolveShares(ctx: LoadContext, shares: readonly ShareCommand[]): ShareInput[] {
  const out: ShareInput[] = [];
  const id = (ref: Ref | undefined | null) => (ref ? ctx.refs.get(ref) : null);
  for (const s of shares) {
    switch (s.scope) {
      case 'public':
      case 'any_user':
        out.push({ scope: s.scope });
        break;
      case 'user': {
        const user = id(s.user);
        if (user === null) ctx.warn({ code: 'share_not_imported', detail: 'user' });
        else out.push({ scope: 'user', userId: user });
        break;
      }
      case 'group': {
        const group = id(s.group);
        if (group === null) ctx.warn({ code: 'share_not_imported', detail: 'group' });
        else out.push({ scope: 'group', groupId: group });
        break;
      }
      case 'track': {
        const track = id(s.track);
        const role = s.role ? id(s.role) : undefined;
        if (track === null || role === null) {
          ctx.warn({ code: 'share_not_imported', detail: 'track' });
        } else {
          out.push({ scope: 'track', trackId: track, roleId: role ?? null });
        }
        break;
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = shareKey(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sharePrint = (shares: readonly ShareInput[]) => shares.map(shareKey).sort();

/** The target's values the slots of some queries need, read in one query per table. */
async function targetValues(ctx: LoadContext, refs: readonly { ref: Ref; as: SlotAs }[]) {
  const ids = new Map<string, number[]>();
  for (const { ref, as } of refs) {
    const id = ctx.refs.get(ref);
    if (id === null || id === PENDING || as === 'id' || as === 'option') continue;
    const list = ids.get(ref.kind) ?? [];
    ids.set(ref.kind, list);
    list.push(id);
  }
  const names = new Map<string, string>();
  const TABLES: Record<string, { table: string; column: string }> = {
    status: { table: 'status', column: 'name' },
    priority: { table: 'priority', column: 'name' },
    ticket_type: { table: 'ticket_type', column: 'name' },
    close_reason: { table: 'close_reason', column: 'name' },
    visibility_level: { table: 'visibility_level', column: 'name' },
    area: { table: 'area', column: 'name' },
    release: { table: 'release', column: 'name' },
    track: { table: 'track', column: 'key' },
    user: { table: 'app_user', column: 'email' },
  };
  for (const [kind, list] of ids) {
    const t = TABLES[kind];
    if (!t || list.length === 0) continue;
    const { rows } = await sql<{ id: number; v: string }>`
      SELECT id, ${sql.ref(t.column)} AS v FROM ${sql.table(t.table)}
       WHERE workspace_id = ${ctx.workspaceId} AND id = ANY(${[...new Set(list)]}::int[])`.execute(
      ctx.trx,
    );
    for (const r of rows) names.set(`${kind}\u0000${r.id}`, r.v);
  }
  return names;
}

/** The query as the target holds it: text, and the reason it cannot run (null when it can). */
async function finishQuery(
  ctx: LoadContext,
  cmd: SavedSearchCommand,
  owner: number,
): Promise<{ text: string; problem: string | null }> {
  const problemOf = (notes: readonly Note[]) =>
    notes
      .map((n) => n.message)
      .join('; ')
      .slice(0, MAX_PROBLEM);
  const q = cmd.query;
  if (q.template === null) {
    return {
      text: q.source.slice(0, MAX_QUERY),
      problem: problemOf(q.problems) || 'not translated',
    };
  }
  const template = q.template as unknown as Query;
  const { slots } = slotsOf(template);
  const names = await targetValues(ctx, slots);
  const span = { start: 0, end: 0 };
  const rendered = renderQuery(template, {
    field: (ref) => {
      const id = ctx.refs.get(ref);
      if (id === null) return null;
      if (id === PENDING) return 0;
      return ctx.catalog.fields.has(id) ? id : null;
    },
    value: (ref, as): Value | null => {
      const id = ctx.refs.get(ref);
      if (id === null) return null;
      if (id === PENDING) return { kind: 'word', value: 'pending', span };
      switch (as) {
        case 'id':
          return { kind: 'number', value: id, span };
        case 'option': {
          const option = ctx.catalog.options.get(id);
          return option ? { kind: 'string', value: option.value, span } : null;
        }
        case 'key': {
          const key = names.get(`${ref.kind}\u0000${id}`);
          return key === undefined ? null : { kind: 'word', value: key, span };
        }
        default: {
          const name = names.get(`${ref.kind}\u0000${id}`);
          return name === undefined ? null : { kind: 'string', value: name, span };
        }
      }
    },
  });
  if ('problems' in rendered) {
    for (const p of rendered.problems) {
      ctx.warn({ code: 'query_not_translated', detail: `${p.code}: ${p.detail.split(' ')[0]}` });
    }
    return { text: q.source.slice(0, MAX_QUERY), problem: problemOf(rendered.problems) };
  }
  const text = rendered.text.slice(0, MAX_QUERY);
  if (q.flags.length > 0) return { text, problem: problemOf(q.flags) };
  if (ctx.dryRun || owner === PENDING) return { text, problem: null };
  // Prepared as its owner would run it: references, people, options, saved searches they see.
  await sql`SAVEPOINT translate_check`.execute(ctx.trx);
  try {
    await prepareSearch({
      db: ctx.trx,
      workspaceId: ctx.workspaceId,
      catalog: ctx.catalog,
      catalogue: await queryCatalogue(ctx.trx, ctx.workspaceId, ctx.catalog, 'all'),
      filter: { sql: sql<boolean>`true`, tracks: 'all' },
      q: text,
      currentUserId: owner,
      allowedTracks: async () => 'all',
    });
    await sql`RELEASE SAVEPOINT translate_check`.execute(ctx.trx);
    return { text, problem: null };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT translate_check`.execute(ctx.trx);
    if (!(error instanceof QueryError) && !(error instanceof SearchError)) throw error;
    const note = refusal(error);
    ctx.warn({ code: 'query_not_translated', detail: `${note.code}: ${firstWords(note.detail)}` });
    return { text, problem: note.message.slice(0, MAX_PROBLEM) };
  }
}

/** A refusal as the report lists it: the target's words, names included, cut short. */
const firstWords = (s: string) => s.slice(0, 120);

interface SavedSearchData {
  owner: number;
  name: string;
  query: string;
  problem: string | null;
  shares: ShareInput[];
  stars: number[];
}

/** A name the owner does not have yet: the source's, or it with " (imported)" and a number. */
async function freeName(ctx: LoadContext, owner: number, name: string, except: number | null) {
  const base = name.slice(0, 240);
  for (let n = 1; n < 100; n++) {
    const candidate =
      n === 1 ? base : n === 2 ? `${base} (imported)` : `${base} (imported ${n - 1})`;
    if (owner === PENDING) return candidate;
    const taken = await ctx.trx
      .selectFrom('saved_search')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('owner_id', '=', owner)
      .where(sql<string>`lower(name)`, '=', lower(candidate))
      .executeTakeFirst();
    if (!taken || taken.id === except) {
      if (n > 1) ctx.warn({ code: 'name_taken' });
      return candidate;
    }
  }
  throw new PlanFailure('name_taken');
}

const savedSearchPrint = (
  d: Omit<SavedSearchData, 'owner'> & { owner: number | null },
): JsonValue => ({
  owner: d.owner,
  name: d.name,
  query: d.query,
  problem: d.problem !== null,
  shares: sharePrint(d.shares),
  stars: [...new Set(d.stars)].sort((a, b) => a - b),
});

export const savedSearches: Loader<SavedSearchCommand> = {
  table: { name: 'saved_search', id: 'id' },
  async plan(ctx, cmd, existing) {
    const owner = required(ctx, cmd.owner, 'owner');
    if (existing !== null) await existingTarget(ctx, 'saved_search', existing);
    const name = await freeName(ctx, owner, cmd.name, existing);
    const { text, problem } = await finishQuery(ctx, cmd, owner);
    const shares = resolveShares(ctx, cmd.shares);
    const stars = cmd.stars.flatMap((s) => {
      const id = ctx.refs.get(s);
      return id === null || id === PENDING ? [] : [id];
    });
    const data: SavedSearchData = { owner, name, query: text, problem, shares, stars };
    const fingerprint = savedSearchPrint({ ...data, owner: real(owner) });
    return {
      action: existing === null ? 'create' : 'update',
      targetId: existing,
      fingerprint,
      data,
    };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as SavedSearchData;
    let id: number;
    if (plan.action === 'update') {
      id = plan.targetId as number;
      await ctx.trx
        .updateTable('saved_search')
        .set({
          name: d.name,
          description: cmd.description,
          query: d.query,
          import_problem: d.problem,
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', id)
        .execute();
    } else {
      id = (
        await ctx.trx
          .insertInto('saved_search')
          .values({
            workspace_id: ctx.workspaceId,
            owner_id: d.owner,
            name: d.name,
            description: cmd.description,
            query: d.query,
            import_problem: d.problem,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    await writeShares(ctx.trx, SAVED_SEARCH_SHARES, ctx.workspaceId, id, d.shares);
    for (const user of new Set(d.stars)) {
      await sql`INSERT INTO saved_search_star (workspace_id, saved_search_id, user_id)
        VALUES (${ctx.workspaceId}, ${id}, ${user}) ON CONFLICT DO NOTHING`.execute(ctx.trx);
    }
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('saved_search')
      .select(['id', 'owner_id', 'name', 'query', 'import_problem'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    const shares = await sharesOf(db, SAVED_SEARCH_SHARES, [...ids]);
    const stars = await db
      .selectFrom('saved_search_star')
      .select(['saved_search_id', 'user_id'])
      .where('saved_search_id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        savedSearchPrint({
          owner: r.owner_id,
          name: r.name,
          query: r.query,
          problem: r.import_problem,
          shares: (shares.get(r.id) ?? []) as ShareInput[],
          stars: stars.filter((s) => s.saved_search_id === r.id).map((s) => s.user_id),
        }),
      ]),
    );
  },
};

// --- Subscriptions ----------------------------------------------------------------------------

interface SubscriptionData {
  savedSearch: number;
  creator: number;
  group: number | null;
}

const subscriptionPrint = (s: {
  savedSearch: number | null;
  creator: number | null;
  group: number | null;
  schedule: string;
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  cron: string | null;
  timeZone: string;
  onlyIfResults: boolean;
}): JsonValue => ({ ...s });

export const subscriptions: Loader<SubscriptionCommand> = {
  table: { name: 'saved_search_subscription', id: 'id' },
  async plan(ctx, cmd, existing) {
    const savedSearch = required(ctx, cmd.savedSearch, 'savedSearch');
    const creator = required(ctx, cmd.creator, 'creator');
    // A group that did not import fails it: sending to the creator instead would change who gets it.
    const group = cmd.group === null ? null : required(ctx, cmd.group, 'group');
    if (existing !== null) await existingTarget(ctx, 'saved_search_subscription', existing);
    const data: SubscriptionData = { savedSearch, creator, group };
    const fingerprint = subscriptionPrint({
      savedSearch: real(savedSearch),
      creator: real(creator),
      group: real(group),
      schedule: cmd.schedule,
      hour: cmd.hour,
      minute: cmd.minute,
      weekday: cmd.weekday,
      dayOfMonth: cmd.dayOfMonth,
      cron: cmd.cron,
      timeZone: cmd.timeZone,
      onlyIfResults: cmd.onlyIfResults,
    });
    return {
      action: existing === null ? 'create' : 'update',
      targetId: existing,
      fingerprint,
      data,
    };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as SubscriptionData;
    const schedule = {
      schedule: cmd.schedule,
      hour: cmd.hour,
      minute: cmd.minute,
      weekday: cmd.weekday,
      day_of_month: cmd.dayOfMonth,
      cron: cmd.cron,
      time_zone: cmd.timeZone,
      only_if_results: cmd.onlyIfResults,
    };
    const next =
      nextRun(
        {
          schedule: cmd.schedule,
          hour: cmd.hour,
          minute: cmd.minute,
          weekday: cmd.weekday,
          dayOfMonth: cmd.dayOfMonth,
          cron: cmd.cron,
          timeZone: cmd.timeZone,
        },
        new Date(ctx.now),
      ) ?? new Date(Date.parse(ctx.now) + 365 * 86_400_000);
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('saved_search_subscription')
        .set({ ...schedule, next_run_at: next })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const row = await ctx.trx
      .insertInto('saved_search_subscription')
      .values({
        workspace_id: ctx.workspaceId,
        saved_search_id: d.savedSearch,
        created_by: d.creator,
        recipient_user_id: d.group === null ? d.creator : null,
        recipient_group_id: d.group,
        ...schedule,
        next_run_at: next,
        last_run_at: cmd.lastRunAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('saved_search_subscription')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        subscriptionPrint({
          savedSearch: r.saved_search_id,
          creator: r.created_by,
          group: r.recipient_group_id,
          schedule: r.schedule,
          hour: r.hour,
          minute: r.minute,
          weekday: r.weekday,
          dayOfMonth: r.day_of_month,
          cron: r.cron,
          timeZone: r.time_zone,
          onlyIfResults: r.only_if_results,
        }),
      ]),
    );
  },
};

// --- Dashboards -------------------------------------------------------------------------------

interface DashboardData {
  owner: number;
  widgets: Widget[];
  shares: ShareInput[];
}

/** Widgets without their generated ids, as the sample compares them. */
const widgetPrint = (widgets: readonly Widget[]) =>
  widgets.map((w) => ({ kind: w.kind, column: w.column, config: w.config as JsonValue }));

const dashboardPrint = (d: {
  owner: number | null;
  name: string;
  layout: string;
  widgets: readonly Widget[];
  shares: readonly ShareInput[];
}): JsonValue => ({
  owner: d.owner,
  name: d.name,
  layout: d.layout,
  widgets: widgetPrint(d.widgets),
  shares: sharePrint(d.shares),
});

/** The widgets with their references resolved; one whose reference did not import is left out. */
async function resolveWidgets(ctx: LoadContext, cmd: DashboardCommand): Promise<Widget[]> {
  const out: Widget[] = [];
  for (const w of cmd.widgets) {
    const config: Record<string, unknown> = { ...w.config };
    const missing = (what: string) => {
      ctx.warn({ code: 'widget_reference_not_imported', detail: `${w.kind} ${what}` });
    };
    if (w.query) {
      if ('savedSearch' in w.query) {
        const id = ctx.refs.get(w.query.savedSearch);
        if (id === null) {
          missing('saved_search');
          continue;
        }
        config.query = `savedSearch = ${id === PENDING ? 0 : id}`;
      } else {
        const id = ctx.refs.get(w.query.track);
        const key =
          id === null || id === PENDING
            ? null
            : (
                await ctx.trx
                  .selectFrom('track')
                  .select('key')
                  .where('id', '=', id)
                  .executeTakeFirst()
              )?.key;
        if (id === null || (id !== PENDING && !key)) {
          missing('track');
          continue;
        }
        config.query = `track = ${key ?? 'PENDING'}`;
      }
    }
    if (w.board) {
      const id = ctx.refs.get(w.board);
      if (id === null) {
        missing('board');
        continue;
      }
      config.boardId = id === PENDING ? 1 : id;
    }
    if (w.field) {
      const id = ctx.refs.get(w.field);
      if (id === null) {
        missing('field');
        continue;
      }
      config.field = `cf[${id === PENDING ? 0 : id}]`;
    }
    const input: WidgetInput = { kind: w.kind, column: w.column, title: w.title, config };
    const checked = readWidgets([input], cmd.layout);
    if ('fields' in checked) {
      ctx.warn({
        code: 'widget_not_imported',
        detail: `${w.kind} ${Object.keys(checked.fields)[0]}`,
      });
      continue;
    }
    out.push(...checked.widgets);
  }
  return out;
}

export const dashboards: Loader<DashboardCommand> = {
  table: { name: 'dashboard', id: 'id' },
  async plan(ctx, cmd, existing) {
    const owner = required(ctx, cmd.owner, 'owner');
    if (existing !== null) await existingTarget(ctx, 'dashboard', existing);
    const widgets = await resolveWidgets(ctx, cmd);
    const shares = resolveShares(ctx, cmd.shares);
    const data: DashboardData = { owner, widgets, shares };
    const fingerprint = dashboardPrint({
      owner: real(owner),
      name: cmd.name,
      layout: cmd.layout,
      widgets,
      shares,
    });
    return {
      action: existing === null ? 'create' : 'update',
      targetId: existing,
      fingerprint,
      data,
    };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as DashboardData;
    let id: number;
    if (plan.action === 'update') {
      id = plan.targetId as number;
      await ctx.trx
        .updateTable('dashboard')
        .set({
          name: cmd.name,
          description: cmd.description,
          layout: cmd.layout,
          widgets: JSON.stringify(d.widgets),
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', id)
        .execute();
    } else {
      id = (
        await ctx.trx
          .insertInto('dashboard')
          .values({
            workspace_id: ctx.workspaceId,
            owner_id: d.owner,
            name: cmd.name,
            description: cmd.description,
            layout: cmd.layout,
            widgets: JSON.stringify(d.widgets),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    await writeShares(ctx.trx, DASHBOARD_SHARES, ctx.workspaceId, id, d.shares);
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('dashboard')
      .select(['id', 'owner_id', 'name', 'layout', 'widgets'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    const shares = await sharesOf(db, DASHBOARD_SHARES, [...ids]);
    return new Map(
      rows.map((r) => [
        r.id,
        dashboardPrint({
          owner: r.owner_id,
          name: r.name,
          layout: r.layout,
          widgets: (r.widgets as unknown as Widget[]) ?? [],
          shares: (shares.get(r.id) ?? []) as ShareInput[],
        }),
      ]),
    );
  },
};

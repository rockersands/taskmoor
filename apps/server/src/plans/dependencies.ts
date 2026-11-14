import type { Database } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';

/**
 * A plan's dependencies (PLN-006, PLN-013; ADR-122 stages 2 and 5), read the same way for the
 * Timeline and the program board.
 *
 * - A dependency is a blocking link (its type's outward phrase is "blocks"), or a link of a type
 *   the plan chose (`plan_dependency_type`). Its **source finishes first** and its target waits for
 *   it, as "A blocks B" reads. Two links between the same pair are one dependency, a blocking one
 *   first.
 * - Of the listed tickets' blockers outside the trash, those listed are links to draw; the rest are
 *   only counted per blocked ticket: `unlisted` when the blocker is the plan's own for this viewer
 *   (`unfiltered`), else `outside` (outside the plan, or hidden from the viewer), never named.
 * - With the plan's flag, a drawn dependency whose two tickets are in the same open sprint (future
 *   or active, not deleted) is marked `sameSprint`. Only drawn ones are judged, and no sprint is
 *   named, so the flag says nothing of hidden work.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface DependencyOptions {
  /** Link types counted beside blocking links. */
  linkTypeIds: number[];
  /** Whether dependencies within one sprint are marked. */
  sameSprint: boolean;
}

export interface DependencyLink {
  /** The blocker: it finishes first. */
  from: number;
  /** The ticket that waits for it. */
  to: number;
  linkTypeId: number;
  sameSprint?: true;
}

export interface BlockersElsewhere {
  id: number;
  outside: number;
  unlisted: number;
}

/** How many link types a plan counts beside blocking links. */
export const MAX_DEPENDENCY_TYPES = 20;

/** A plan's dependency options. */
export async function dependencyOptions(db: Db, planId: number): Promise<DependencyOptions> {
  const plan = await db
    .selectFrom('plan')
    .select('flag_same_sprint')
    .where('id', '=', planId)
    .executeTakeFirst();
  const types = await db
    .selectFrom('plan_dependency_type')
    .select('link_type_id')
    .where('plan_id', '=', planId)
    .orderBy('link_type_id')
    .execute();
  return {
    linkTypeIds: types.map((t) => t.link_type_id),
    sameSprint: plan?.flag_same_sprint ?? false,
  };
}

/** Link types as an answer names them: id, name and the phrases. */
export async function linkTypesNamed(
  db: Db,
  ws: number,
  ids: readonly number[],
): Promise<{ id: number; name: string; outward: string; inward: string }[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom('link_type')
    .select(['id', 'name', 'outward', 'inward'])
    .where('workspace_id', '=', ws)
    .where('id', 'in', [...ids])
    .orderBy('id')
    .execute();
}

/**
 * Every dependency whose target is one of `targetIds`: a blocking link or a link of a type the
 * plan chose, one per pair of tickets with the blocking one first (then the lowest type id), and
 * never one whose blocker is in the trash. Blockers are not checked against the plan or the
 * reader: callers decide which they may show. Ordered by blocker, then target.
 */
export async function blockingLinks(
  trx: Db,
  ws: number,
  targetIds: readonly number[],
  options: Pick<DependencyOptions, 'linkTypeIds'>,
): Promise<Omit<DependencyLink, 'sameSprint'>[]> {
  if (targetIds.length === 0) return [];
  const rows = (
    await sql<{ from: number; to: number; link_type_id: number }>`
      SELECT DISTINCT ON (l.source_id, l.target_id)
             l.source_id AS from, l.target_id AS to, l.link_type_id
        FROM ticket_link l JOIN link_type lt ON lt.id = l.link_type_id
        JOIN ticket b ON b.id = l.source_id
       WHERE l.workspace_id = ${ws}::int
         AND (lower(lt.outward) = 'blocks' OR lt.id = ANY(${[...options.linkTypeIds]}::int[]))
         AND l.target_id = ANY(${[...targetIds]}::int[]) AND b.deleted_at IS NULL
       ORDER BY l.source_id, l.target_id, (lower(lt.outward) = 'blocks') DESC, lt.id`.execute(trx)
  ).rows;
  return rows.map((r) => ({ from: r.from, to: r.to, linkTypeId: r.link_type_id }));
}

/**
 * The dependencies of the listed tickets `ids`: the links among them to draw, and the blockers
 * they do not list, counted. `unfiltered` is the plan's tickets for this viewer without the
 * filters; `checkPlan` false says every ticket of the plan is listed, so no blocker is the plan's.
 */
export async function readDependencies(
  trx: Db,
  ws: number,
  ids: readonly number[],
  options: DependencyOptions,
  plan: { unfiltered: RawBuilder<boolean>; checkPlan: boolean },
): Promise<{ links: DependencyLink[]; elsewhere: BlockersElsewhere[]; linkTypeIds: number[] }> {
  if (ids.length === 0) return { links: [], elsewhere: [], linkTypeIds: [] };
  const all = await blockingLinks(trx, ws, ids, options);
  const listed = new Set(ids);
  const drawn = all.filter((l) => listed.has(l.from));
  const others = all.filter((l) => !listed.has(l.from));
  const blockers = [...new Set(others.map((l) => l.from))];
  const inPlan = new Set(
    plan.checkPlan && blockers.length > 0
      ? (
          await sql<{ id: number }>`
            SELECT k.id FROM ticket k
             WHERE k.id = ANY(${blockers}::int[]) AND ${plan.unfiltered}`.execute(trx)
        ).rows.map((r) => r.id)
      : [],
  );
  const counted = new Map<number, BlockersElsewhere>();
  for (const l of others) {
    const entry = counted.get(l.to) ?? { id: l.to, outside: 0, unlisted: 0 };
    if (inPlan.has(l.from)) entry.unlisted++;
    else entry.outside++;
    counted.set(l.to, entry);
  }
  const together = new Set<string>();
  if (options.sameSprint && drawn.length > 0) {
    const rows = (
      await sql<{ from: number; to: number }>`
        SELECT p.f AS from, p.t AS to
          FROM unnest(${drawn.map((l) => l.from)}::int[], ${drawn.map((l) => l.to)}::int[]) AS p(f, t)
         WHERE EXISTS (
           SELECT 1 FROM sprint_ticket a
             JOIN sprint_ticket b ON b.sprint_id = a.sprint_id AND b.ticket_id = p.t AND b.open
             JOIN sprint s ON s.id = a.sprint_id AND s.deleted_at IS NULL AND s.state <> 'closed'
            WHERE a.ticket_id = p.f AND a.open)`.execute(trx)
    ).rows;
    for (const r of rows) together.add(`${r.from}>${r.to}`);
  }
  const links: DependencyLink[] = drawn.map((l) => ({
    from: l.from,
    to: l.to,
    linkTypeId: l.linkTypeId,
    ...(together.has(`${l.from}>${l.to}`) ? { sameSprint: true as const } : {}),
  }));
  return {
    links,
    elsewhere: [...counted.values()].sort((a, b) => a.id - b.id),
    linkTypeIds: [...new Set(drawn.map((l) => l.linkTypeId))].sort((a, b) => a - b),
  };
}

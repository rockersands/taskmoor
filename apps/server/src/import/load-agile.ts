import { parseQuery } from '@taskmoor/query';
import { sql } from 'kysely';
import {
  type Column,
  DEFAULT_BOARD_FILTERS,
  DEFAULT_CARD_RULES,
  DEFAULT_SWIMLANES,
} from '../boards/model';
import { DEFAULT_SPRINT_SETTINGS } from '../sprints/model';
import { existingTarget, type Loader, lower, PENDING, real, required } from './load';
import type { BoardCommand, SprintCommand } from './model';

/**
 * Boards and sprints (M1-095; IMP-002; ADR-094). They are written with SQL like the other
 * loaders, keeping what the source says: a sprint's state and dates as they were, a closed
 * sprint's tickets in its history. Board settings the source does not carry take the defaults
 * a new board gets (swimlanes, quick filters, card rules, sprint settings).
 */

interface BoardData {
  track: number;
  query: string;
  columns: Column[];
}

export const boards: Loader<BoardCommand> = {
  table: { name: 'board', id: 'id' },
  async plan(ctx, cmd, existing) {
    const track = required(ctx, cmd.track, 'track');
    let query = cmd.query;
    if (query !== null) {
      try {
        parseQuery(query);
      } catch {
        ctx.warn({ code: 'board_query_not_imported' });
        query = null;
      }
    }
    if (query === null) {
      const key =
        track === PENDING
          ? null
          : (
              await ctx.trx
                .selectFrom('track')
                .select('key')
                .where('id', '=', track)
                .executeTakeFirst()
            )?.key;
      query = `track = ${key ?? 'PENDING'}`;
    }
    const columns: Column[] = cmd.columns.map((c, i) => ({
      id: `c${i + 1}`,
      name: c.name,
      statusIds: c.statuses.flatMap((s) => {
        const id = ctx.refs.get(s);
        if (id === null) ctx.warn({ code: 'missing_reference', detail: 'columns.statuses' });
        return id === null || id === PENDING ? [] : [id];
      }),
      min: c.min,
      max: c.max,
    }));
    const data: BoardData = { track, query, columns };
    const fingerprint = {
      name: cmd.name,
      kind: cmd.boardKind,
      track: real(track),
      columns: columns.map((c) => ({ name: c.name, statusIds: c.statusIds })),
    };
    if (existing !== null) {
      await existingTarget(ctx, 'board', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    if (track !== PENDING) {
      const found = await ctx.trx
        .selectFrom('board')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('location_track_id', '=', track)
        .where(sql<string>`lower(name)`, '=', lower(cmd.name))
        .executeTakeFirst();
      if (found) return { action: 'link', targetId: found.id, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as BoardData;
    if (plan.action === 'link') return plan.targetId as number;
    if (plan.action === 'update') {
      const id = plan.targetId as number;
      await ctx.trx
        .updateTable('board')
        .set({
          name: cmd.name,
          description: cmd.description,
          columns: JSON.stringify(d.columns),
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', id)
        .execute();
      return id;
    }
    const row = await ctx.trx
      .insertInto('board')
      .values({
        workspace_id: ctx.workspaceId,
        name: cmd.name,
        description: cmd.description,
        kind: cmd.boardKind,
        location_track_id: d.track,
        location_user_id: null,
        filter_query: d.query,
        sub_filter_query: null,
        columns: JSON.stringify(d.columns),
        swimlanes: JSON.stringify(DEFAULT_SWIMLANES),
        board_filters: JSON.stringify(DEFAULT_BOARD_FILTERS),
        card_rules: JSON.stringify(DEFAULT_CARD_RULES),
        sprint_settings: JSON.stringify(DEFAULT_SPRINT_SETTINGS),
        created_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('board')
      .select(['id', 'name', 'kind', 'location_track_id', 'columns'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: r.name,
          kind: r.kind,
          track: r.location_track_id,
          columns: (r.columns as unknown as Column[]).map((c) => ({
            name: c.name,
            statusIds: c.statusIds,
          })),
        },
      ]),
    );
  },
};

interface SprintData {
  board: number;
  tickets: number[];
}

const instant = (v: string | null) => (v === null ? null : new Date(v));

export const sprints: Loader<SprintCommand> = {
  table: { name: 'sprint', id: 'id' },
  async plan(ctx, cmd, existing) {
    const board = required(ctx, cmd.board, 'board');
    const tickets: number[] = [];
    for (const t of cmd.tickets) {
      const id = ctx.refs.get(t);
      if (id === null) ctx.warn({ code: 'missing_reference', detail: 'tickets' });
      else if (id !== PENDING) tickets.push(id);
    }
    const sorted = [...new Set(tickets)].sort((a, b) => a - b);
    const fingerprint = {
      board: real(board),
      name: cmd.name,
      state: cmd.state,
      tickets: sorted,
    };
    const data: SprintData = { board, tickets: sorted };
    if (existing !== null) {
      await existingTarget(ctx, 'sprint', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as SprintData;
    const values = {
      name: cmd.name,
      goal: cmd.goal,
      state: cmd.state,
      start_at: instant(cmd.startAt),
      end_at: instant(cmd.endAt),
      started_at: instant(cmd.startedAt),
      completed_at: instant(cmd.completedAt),
    };
    let id = plan.targetId as number;
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('sprint')
        .set({ ...values, updated_at: new Date(), version: sql`version + 1` })
        .where('id', '=', id)
        .execute();
    } else {
      const top = await ctx.trx
        .selectFrom('sprint')
        .select((eb) => eb.fn.max('sequence').as('top'))
        .where('board_id', '=', d.board)
        .executeTakeFirst();
      id = (
        await ctx.trx
          .insertInto('sprint')
          .values({
            workspace_id: ctx.workspaceId,
            board_id: d.board,
            sequence: Number(top?.top ?? 0) + 1,
            created_by: null,
            ...values,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    if (d.tickets.length === 0) return id;
    const open = cmd.state !== 'closed';
    // A ticket already in another open sprint stays there: one open sprint per ticket.
    const busy = open
      ? new Set(
          (
            await ctx.trx
              .selectFrom('sprint_ticket')
              .select('ticket_id')
              .where('ticket_id', 'in', d.tickets)
              .where('open', '=', true)
              .where('sprint_id', '<>', id)
              .execute()
          ).map((r) => r.ticket_id),
        )
      : new Set<number>();
    if (busy.size > 0) ctx.warn({ code: 'ticket_in_another_open_sprint' });
    const adding = d.tickets.filter((t) => !busy.has(t));
    if (adding.length > 0) {
      await ctx.trx
        .insertInto('sprint_ticket')
        .values(
          adding.map((ticketId) => ({
            workspace_id: ctx.workspaceId,
            sprint_id: id,
            ticket_id: ticketId,
            open,
            added_at: instant(cmd.startedAt ?? cmd.startAt) ?? new Date(),
          })),
        )
        .onConflict((oc) => oc.columns(['sprint_id', 'ticket_id']).doNothing())
        .execute();
    }
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('sprint')
      .select(['id', 'board_id', 'name', 'state'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    const members = await db
      .selectFrom('sprint_ticket')
      .select(['sprint_id', 'ticket_id'])
      .where('sprint_id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        {
          board: r.board_id,
          name: r.name,
          state: r.state,
          tickets: members
            .filter((m) => m.sprint_id === r.id)
            .map((m) => m.ticket_id)
            .sort((a, b) => a - b),
        },
      ]),
    );
  },
};

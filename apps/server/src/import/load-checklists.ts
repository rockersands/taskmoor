import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { existingTarget, type Loader, optional, real, required } from './load';
import type { ChecklistCommand } from './model';

type Db = Kysely<Database> | Transaction<Database>;

interface ChecklistData {
  ticket: number;
  creator: number | null;
  items: {
    text: string;
    state: string;
    position: number;
    creator: number | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

const print = (c: {
  ticket: number | null;
  name: string;
  position: number;
  items: { text: string; state: string }[];
}): JsonValue => ({
  ticket: real(c.ticket),
  name: c.name,
  position: c.position,
  items: c.items.map((i) => ({ text: i.text, state: i.state })),
});

/**
 * A checklist of Taskmoor's own export (CORE-033; IMP-014): one record with its items, which have
 * no life of their own. A re-run rewrites the items, so a later export of the same workspace comes
 * back as it was. The verbatim history carries the changes, so nothing writes history here.
 */
export const checklists: Loader<ChecklistCommand> = {
  table: { name: 'ticket_checklist', id: 'id' },
  async plan(ctx, cmd, existing) {
    const data: ChecklistData = {
      ticket: required(ctx, cmd.ticket, 'ticket'),
      creator: optional(ctx, cmd.creator, 'creator'),
      items: cmd.items.map((item) => ({
        text: item.text,
        state: item.state,
        position: item.position,
        creator: optional(ctx, item.creator, 'itemCreator'),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    };
    const fingerprint = print({
      ticket: data.ticket,
      name: cmd.name,
      position: cmd.position,
      items: data.items,
    });
    if (existing !== null) {
      await existingTarget(ctx, 'ticket_checklist', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as ChecklistData;
    let target = plan.targetId;
    if (plan.action === 'update' && target !== null) {
      await ctx.trx
        .updateTable('ticket_checklist')
        .set({ name: cmd.name, position: cmd.position, updated_at: cmd.updatedAt })
        .where('id', '=', target)
        .execute();
      await ctx.trx
        .deleteFrom('ticket_checklist_item')
        .where('checklist_id', '=', target)
        .execute();
    } else {
      target = (
        await ctx.trx
          .insertInto('ticket_checklist')
          .values({
            workspace_id: ctx.workspaceId,
            ticket_id: d.ticket,
            name: cmd.name,
            position: cmd.position,
            created_by: d.creator,
            created_at: cmd.createdAt,
            updated_at: cmd.updatedAt,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    if (d.items.length > 0) {
      await ctx.trx
        .insertInto('ticket_checklist_item')
        .values(
          d.items.map((item) => ({
            workspace_id: ctx.workspaceId,
            checklist_id: target as number,
            text: item.text,
            state: item.state,
            position: item.position,
            created_by: item.creator,
            created_at: item.createdAt,
            updated_at: item.updatedAt,
          })),
        )
        .execute();
    }
    return target as number;
  },
  async read(db: Db, ws, ids) {
    const lists = await db
      .selectFrom('ticket_checklist')
      .select(['id', 'ticket_id', 'name', 'position'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    const items = await sql<{ checklist_id: number; text: string; state: string }>`
      SELECT checklist_id, text, state FROM ticket_checklist_item
       WHERE checklist_id = ANY(${[...ids]}::int[])
       ORDER BY checklist_id, position, id`.execute(db);
    return new Map(
      lists.map((l) => [
        l.id,
        print({
          ticket: l.ticket_id,
          name: l.name,
          position: l.position,
          items: items.rows.filter((i) => i.checklist_id === l.id),
        }),
      ]),
    );
  },
};

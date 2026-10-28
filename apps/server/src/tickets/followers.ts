import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';

/**
 * Following tickets (M1-015, CORE-019): the personal auto-follow setting and the follow it
 * adds when someone creates, edits or (from M1-017) comments on a ticket.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** Whether a person follows the tickets they create, edit or comment on; on by default. */
export async function autoFollows(db: Db, userId: number): Promise<boolean> {
  const row = await db
    .selectFrom('user_preference')
    .select('auto_follow')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.auto_follow ?? true;
}

/** Makes `userId` follow a ticket when their preference says so (CORE-019). */
export async function autoFollow(
  trx: Transaction<Database>,
  workspaceId: number,
  ticketId: number,
  userId: number,
): Promise<void> {
  if (!(await autoFollows(trx, userId))) return;
  await trx
    .insertInto('ticket_follower')
    .values({ workspace_id: workspaceId, ticket_id: ticketId, user_id: userId })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

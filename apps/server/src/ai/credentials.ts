import type { Database } from '@taskmoor/db';
import { type KeyRing, openEnvelope, rewrapEnvelope, sealEnvelope } from '@taskmoor/iam';
import { type Kysely, sql, type Transaction } from 'kysely';
import { type CredentialSlot, writeAiSettings } from './settings';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * AI provider credentials (M1-075; IAM-020; ADR-098): write-only. They are sealed with envelope
 * encryption on the way in; the only thing any answer, event or log line shows of one is its
 * last four characters. The server opens them only to build a provider client.
 */

/** What may be shown of a secret: its last four characters, or nothing when it is short. */
export function lastFour(value: string): string {
  return value.length >= 12 ? value.slice(-4) : '';
}

/** Binds a ciphertext to its workspace and slot: copied to another row, it does not open. */
const aad = (workspaceId: number, slot: CredentialSlot) =>
  `taskmoor ai credential:${workspaceId}:${slot}`;

export interface CredentialSummary {
  slot: CredentialSlot;
  last4: string;
  source: 'admin' | 'environment';
  updatedAt: string;
  updatedBy: { id: number; name: string } | null;
}

export async function credentialSummaries(
  db: Db,
  workspaceId: number,
): Promise<CredentialSummary[]> {
  const rows = await db
    .selectFrom('ai_credential as c')
    .leftJoin('app_user as u', 'u.id', 'c.updated_by')
    .select(['c.slot', 'c.last4', 'c.source', 'c.updated_at', 'c.updated_by', 'u.name'])
    .where('c.workspace_id', '=', workspaceId)
    .orderBy('c.slot')
    .execute();
  return rows.map((row) => ({
    slot: row.slot,
    last4: row.last4,
    source: row.source,
    updatedAt: row.updated_at.toISOString(),
    updatedBy:
      row.updated_by !== null && row.name !== null ? { id: row.updated_by, name: row.name } : null,
  }));
}

/**
 * Sets or replaces a credential and moves the settings version, so new calls use it while calls
 * in flight finish on the one they started with. Run it in the route's transaction.
 */
export async function storeCredential(
  trx: Transaction<Database>,
  ring: KeyRing,
  input: {
    workspaceId: number;
    slot: CredentialSlot;
    value: string;
    source: 'admin' | 'environment';
    actorId: number | null;
  },
): Promise<{ replaced: boolean; last4: string; version: number }> {
  const sealed = await sealEnvelope(input.value, ring, aad(input.workspaceId, input.slot));
  const last4 = lastFour(input.value);
  const row = await trx
    .insertInto('ai_credential')
    .values({
      workspace_id: input.workspaceId,
      slot: input.slot,
      kek_id: sealed.kekId,
      wrapped_key: sealed.wrappedKey,
      ciphertext: sealed.ciphertext,
      last4,
      source: input.source,
      updated_by: input.actorId,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'slot']).doUpdateSet({
        kek_id: sealed.kekId,
        wrapped_key: sealed.wrappedKey,
        ciphertext: sealed.ciphertext,
        last4,
        source: input.source,
        updated_by: input.actorId,
        updated_at: sql<Date>`now()`,
      }),
    )
    // xmax is 0 for a row this statement inserted, and set for one it updated.
    .returning(sql<boolean>`xmax <> 0`.as('replaced'))
    .executeTakeFirstOrThrow();
  const version = await writeAiSettings(trx, input.workspaceId, input.actorId);
  return { replaced: row.replaced, last4, version };
}

/** Removes a credential; false when there was none. */
export async function removeCredential(
  trx: Transaction<Database>,
  workspaceId: number,
  slot: CredentialSlot,
  actorId: number | null,
): Promise<boolean> {
  const gone = await trx
    .deleteFrom('ai_credential')
    .where('workspace_id', '=', workspaceId)
    .where('slot', '=', slot)
    .executeTakeFirst();
  if (Number(gone.numDeletedRows) === 0) return false;
  await writeAiSettings(trx, workspaceId, actorId);
  return true;
}

/** Every credential of a workspace, opened: only for building its provider client. */
export async function openCredentials(
  db: Db,
  ring: KeyRing,
  workspaceId: number,
): Promise<Map<CredentialSlot, string>> {
  const rows = await db
    .selectFrom('ai_credential')
    .select(['slot', 'kek_id', 'wrapped_key', 'ciphertext'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  const out = new Map<CredentialSlot, string>();
  for (const row of rows) {
    out.set(
      row.slot,
      await openEnvelope(
        { kekId: row.kek_id, wrappedKey: row.wrapped_key, ciphertext: row.ciphertext },
        ring,
        aad(workspaceId, row.slot),
      ),
    );
  }
  return out;
}

/**
 * Re-wraps every data key that the ring's active key did not wrap (after the master key changed,
 * or a move to a KMS), so the previous key can be dropped. Returns how many moved; a row whose
 * key is unknown stays as it is and is counted in `unreadable`.
 */
export async function rewrapCredentials(
  db: Kysely<Database>,
  ring: KeyRing,
): Promise<{ rewrapped: number; unreadable: number }> {
  const active = ring.active;
  if (!active) return { rewrapped: 0, unreadable: 0 };
  const rows = await db
    .selectFrom('ai_credential')
    .select(['workspace_id', 'slot', 'kek_id', 'wrapped_key', 'ciphertext'])
    .where('kek_id', '<>', active.id)
    .execute();
  let rewrapped = 0;
  let unreadable = 0;
  for (const row of rows) {
    const envelope = {
      kekId: row.kek_id,
      wrappedKey: row.wrapped_key,
      ciphertext: row.ciphertext,
    };
    const moved = await rewrapEnvelope(envelope, ring).catch(() => undefined);
    if (!moved) {
      unreadable += moved === undefined ? 1 : 0;
      continue;
    }
    // Only if nobody replaced it meanwhile: a newer value is already under the active key.
    const done = await db
      .updateTable('ai_credential')
      .set({ kek_id: moved.kekId, wrapped_key: moved.wrappedKey })
      .where('workspace_id', '=', row.workspace_id)
      .where('slot', '=', row.slot)
      .where('wrapped_key', '=', row.wrapped_key)
      .executeTakeFirst();
    rewrapped += Number(done.numUpdatedRows);
  }
  return { rewrapped, unreadable };
}

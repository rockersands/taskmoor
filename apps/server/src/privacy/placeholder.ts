/**
 * The identity an erased person's account takes (ASVS 8.3.2, IAM-008 (2); ADR-111): stable,
 * derived from the account's id alone, so every record that points at the account shows the
 * same placeholder and nothing about who it was.
 */
export const ERASED_DOMAIN = 'erased.invalid';
export const erasedName = (id: number) => `Former user ${id}`;
export const erasedEmail = (id: number) => `erased-${id}@${ERASED_DOMAIN}`;

/** A change in a `plan.capacity_set` event: whose capacity, and its amount and note around it. */
interface CapacityChange {
  subject: string;
  from: { amount: number; note: string } | null;
  to: { amount: number; note: string } | null;
}

/**
 * A `plan.capacity_set` payload with the notes of `subject`'s capacity emptied (T-089j; PLN-009):
 * the amounts stay, as the plan's history of capacity does, but not the words, which may say why
 * someone was away. Anything else in the payload is kept as it is.
 */
export function withoutCapacityNotes(payload: unknown, subject: string): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const changes = (payload as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return payload;
  const clear = (side: CapacityChange['from']) => (side ? { ...side, note: '' } : side);
  return {
    ...payload,
    changes: changes.map((c: CapacityChange) =>
      c && c.subject === subject ? { ...c, from: clear(c.from), to: clear(c.to) } : c,
    ),
  };
}

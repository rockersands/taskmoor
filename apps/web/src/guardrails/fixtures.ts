import type { Guardrail, GuardrailsClient } from './client';

const row = (
  name: string,
  def: number,
  value: number,
  where: string | null,
  limit = def,
): Guardrail => ({
  name,
  limit,
  default: def,
  usage: { value, where: where ? { kind: 'track', id: 1, name: where } : null },
});

export const GUARDRAILS: Guardrail[] = [
  row('fields_per_track', 700, 42, 'SHOP'),
  row('releases_per_track', 15_000, 120, 'SHOP'),
  row('areas_per_track', 10_000, 12, 'OPS', 10),
  row('options_per_field', 20_000, 0, null),
];

export interface FakeGuardrailsClient extends GuardrailsClient {
  calls: { name: string; limit: number }[];
}

/** An in-memory backend; Areas per track is already above a lowered limit. */
export function fakeGuardrailsClient(): FakeGuardrailsClient {
  const rows = structuredClone(GUARDRAILS);
  const calls: FakeGuardrailsClient['calls'] = [];
  return {
    calls,
    list: async () => ({ guardrails: structuredClone(rows), ceiling: 1_000_000 }),
    set: async (name, limit) => {
      calls.push({ name, limit });
      const found = rows.find((r) => r.name === name);
      if (found) found.limit = limit;
    },
  };
}

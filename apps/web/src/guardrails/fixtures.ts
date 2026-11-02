import type { Guardrail, GuardrailsClient } from './client';
import type { StorageClient, StorageSettings } from './storage-client';

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

const GIB = 1024 ** 3;

/** A workspace of 42 GiB under a 100 GiB quota, its heaviest uploader at 9.5 of 10 GiB. */
export const STORAGE: StorageSettings = {
  maxFileSize: GIB,
  workspaceQuota: 100 * GIB,
  personQuota: 10 * GIB,
  usage: {
    bytes: 42 * GIB,
    files: 1234,
    topPerson: { id: 7, name: 'Sam Rivera', bytes: 9.5 * GIB, files: 310 },
  },
};

export interface FakeStorageClient extends StorageClient {
  calls: { workspaceQuota: number | null; personQuota: number | null }[];
}

/** An in-memory backend for the storage section; `settings` overrides the starting state. */
export function fakeStorageClient(settings: StorageSettings = STORAGE): FakeStorageClient {
  let current = structuredClone(settings);
  const calls: FakeStorageClient['calls'] = [];
  return {
    calls,
    read: async () => structuredClone(current),
    setQuotas: async (quotas) => {
      calls.push(quotas);
      current = { ...current, ...quotas };
      return structuredClone(current);
    },
  };
}

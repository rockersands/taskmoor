import { ApiError } from '../api/client';
import type { AllowlistSave, AllowlistView, NetworkAccessClient } from './NetworkAccessPage';
import { parseEntries } from './NetworkAccessPage';

const GROUPS = [
  { id: 4, name: 'Travelling staff' },
  { id: 9, name: 'Contractors' },
];

/** An in-memory allowlist API: the caller is at 203.0.113.10. */
export function fakeNetworkClient(
  start: Partial<AllowlistView['allowlist']> = {},
): NetworkAccessClient & { saved: AllowlistSave[] } {
  const address = '203.0.113.10';
  let list: AllowlistView['allowlist'] = {
    enabled: false,
    exemptGroups: [],
    entries: [],
    ...start,
  };
  const inside = (entries: { range: string }[]) =>
    entries.some((e) => e.range === address || e.range.startsWith('203.0.113.'));
  const view = (): AllowlistView => ({
    allowlist: list,
    yourAddress: address,
    yourAddressAllowed: inside(list.entries),
  });
  const saved: AllowlistSave[] = [];
  return {
    saved,
    load: async () => view(),
    groups: async () => GROUPS,
    save: async (next) => {
      const bad = next.entries
        .map((e, i) => (/^[\d.:a-f/]+$/i.test(e.range) ? null : i))
        .filter((i): i is number => i !== null);
      if (bad.length > 0) {
        throw new ApiError(400, {
          error: 'invalid_fields',
          fields: Object.fromEntries(bad.map((i) => [`entries.${i}.range`, 'invalid_range'])),
        });
      }
      if (next.enabled && !inside(next.entries) && !next.confirmLockout) {
        throw new ApiError(409, { error: 'would_lock_you_out', address });
      }
      saved.push(next);
      list = {
        enabled: next.enabled,
        exemptGroups: GROUPS.filter((g) => next.exemptGroupIds.includes(g.id)),
        entries: next.entries,
      };
      return view();
    },
  };
}

export const OFFICE_LIST = {
  enabled: true,
  exemptGroups: [{ id: 4, name: 'Travelling staff' }],
  entries: parseEntries('203.0.113.0/24 # Office\n2001:db8::/32 # Office, IPv6'),
};

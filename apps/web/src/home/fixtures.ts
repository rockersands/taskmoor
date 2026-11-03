import type { HomeClient, HomeTicket, HomeTrack } from './client';

const ticket = (
  id: number,
  key: string,
  summary: string,
  status: HomeTicket['status'],
): HomeTicket => ({
  id,
  key,
  summary,
  status,
  track: { key: key.split('-')[0] as string, name: 'Shop' },
  updatedAt: '2026-10-29T08:00:00Z',
});

export const ASSIGNED = [
  ticket(41, 'SHOP-41', 'Refunds fail for expired cards', { name: 'Active', stage: 'active' }),
  ticket(44, 'SHOP-44', 'Receipts show the wrong currency', { name: 'New', stage: 'new' }),
];
export const RECENT = [
  ticket(44, 'SHOP-44', 'Receipts show the wrong currency', { name: 'New', stage: 'new' }),
  ticket(12, 'SHOP-12', 'Checkout times out on slow networks', { name: 'Closed', stage: 'closed' }),
];
export const FOLLOWED = [
  ticket(41, 'SHOP-41', 'Refunds fail for expired cards', { name: 'Active', stage: 'active' }),
];

/** An in-memory backend; `failing` names lists that fail, `empty` lists with nothing. */
export function fakeHomeClient(
  options: { failing?: (keyof HomeClient)[]; empty?: (keyof HomeClient)[] } = {},
): HomeClient {
  const answer = (list: keyof HomeClient, tickets: HomeTicket[]) => async () => {
    if (options.failing?.includes(list)) throw new Error('offline');
    return options.empty?.includes(list) ? [] : structuredClone(tickets);
  };
  return {
    assigned: answer('assigned', ASSIGNED),
    recent: answer('recent', RECENT),
    followed: answer('followed', FOLLOWED),
  };
}

export const TRACKS: HomeTrack[] = [
  { id: 1, key: 'SHOP', name: 'Shop', type: 'software' },
  { id: 2, key: 'OPS', name: 'Operations', type: 'business' },
];

/** The tracks the person belongs to; `empty` for someone in none, `failing` for an error. */
export function fakeHomeTracks(options: { empty?: boolean; failing?: boolean } = {}) {
  return async (): Promise<HomeTrack[]> => {
    if (options.failing) throw new Error('offline');
    return options.empty ? [] : structuredClone(TRACKS);
  };
}

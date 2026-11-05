import type {
  Candidate,
  CrossTrackClient,
  CrossTrackRelease,
  CrossTrackRow,
  LinkedRelease,
  MoveAnswer,
  MoveLine,
  NewCrossTrack,
} from './crossTrackClient';

/**
 * An in-memory release across tracks for stories and tests (PLN-007): Spring launch ends on
 * 2026-12-01 over Shop 2.0, on that day, and Operations 1.4, on 2026-12-08 and so out of step; a
 * release and four open tickets are hidden from the viewer. The viewer administers Shop only, so a
 * move takes Shop 2.0 and leaves Operations 1.4. Moves, links and edits change it as the server
 * would, and a stale version is refused.
 */
const counted = (query: string, count: number) => ({ query, count, exact: true });

const SHOP = { id: 1, key: 'SHOP', name: 'Shop' };
const OPS = { id: 2, key: 'OPS', name: 'Operations' };

const linked = (
  id: number,
  name: string,
  track: LinkedRelease['track'],
  releaseDate: string | null,
  extra: Partial<LinkedRelease> = {},
): LinkedRelease => ({
  id,
  name,
  track,
  startDate: null,
  releaseDate,
  shipped: false,
  archived: false,
  trackArchived: false,
  overdue: false,
  outOfStep: false,
  progress: { tickets: 4, closed: 1, open: 3 },
  mayRemove: track.id === SHOP.id,
  ...extra,
});

export interface FakeCrossTrackOptions {
  /** The viewer is its owner or an administrator. */
  mayManage?: boolean;
  /** Nothing to list. */
  empty?: boolean;
  /** Everything has shipped. */
  shipped?: boolean;
  /** How many linked releases are hidden from the viewer. */
  hiddenReleases?: number;
  /** A move finds someone else changed it first, once. */
  staleOnce?: boolean;
}

export function fakeCrossTrackClient(
  options: FakeCrossTrackOptions = {},
): CrossTrackClient & { moved: () => string | null; unlinked: () => number[] } {
  const mayManage = options.mayManage ?? true;
  const hiddenReleases = options.hiddenReleases ?? 1;
  let stale = options.staleOnce ?? false;
  let version = 3;
  let name = 'Spring launch';
  let description = 'Shop and Operations go out together.';
  let date: string | null = '2026-12-01';
  let endRule: 'fixed_date' | 'work_complete' = 'fixed_date';
  let exists = !options.empty;
  let lastMove: string | null = null;
  const removed: number[] = [];
  let members: LinkedRelease[] = options.shipped
    ? [
        linked(21, '2.0', SHOP, '2026-12-01', {
          shipped: true,
          progress: { tickets: 4, closed: 4, open: 0 },
        }),
      ]
    : [
        linked(21, '2.0', SHOP, '2026-12-01'),
        linked(22, '1.4', OPS, '2026-12-08', { outOfStep: true }),
      ];
  const refreshSteps = () => {
    members = members.map((m) => ({
      ...m,
      outOfStep: endRule === 'fixed_date' && !m.shipped && !m.archived && m.releaseDate !== date,
    }));
  };
  const state = (): CrossTrackRelease['state'] =>
    options.shipped ? 'shipped' : members.length === 0 ? 'empty' : 'upcoming';
  const open = () => members.reduce((n, m) => n + m.progress.open, 0);
  const closed = () => members.reduce((n, m) => n + m.progress.closed, 0);
  const hidden = () => ({ releases: hiddenReleases, open: hiddenReleases === 0 ? 0 : 4 });
  const answer = (): CrossTrackRelease => {
    const base = 'crossTrackRelease = 5';
    const steps = members.filter((m) => m.outOfStep).length;
    return {
      id: 5,
      name,
      description,
      endRule,
      date,
      state: state(),
      owner: { id: 3, name: 'Ana Ruiz' },
      version,
      stages: {
        new: counted(`${base} AND stage = new`, Math.max(open() - 1, 0)),
        active: counted(`${base} AND stage = active`, Math.min(open(), 1)),
        closed: counted(`${base} AND stage = closed`, closed()),
      },
      open: counted(`${base} AND stage != closed`, open()),
      warnings: steps > 0 ? [{ code: 'out_of_step', count: steps }] : [],
      members: structuredClone(members),
      hidden: hidden(),
      tickets: [
        {
          id: 201,
          key: 'SHOP-201',
          summary: 'Pay by card',
          type: 'Feature',
          status: 'Active',
          stage: 'active',
          assignee: 'Ana Ruiz',
        },
      ],
      truncated: false,
      viewer: { mayManage },
    };
  };
  const row = (): CrossTrackRow => ({
    id: 5,
    name,
    endRule,
    date,
    state: state(),
    owner: { id: 3, name: 'Ana Ruiz' },
    tracks: members.map((m) => m.track),
    progress: { tickets: open() + closed(), closed: closed(), open: open() },
    hidden: hidden(),
    version,
  });
  const lines = (to: string): MoveLine[] =>
    members.map((m) => {
      const base = { id: m.id, name: m.name, track: m.track, from: m.releaseDate, to };
      if (m.shipped) return { ...base, outcome: 'stays', reason: 'shipped' };
      if (m.track.id !== SHOP.id) return { ...base, outcome: 'stays', reason: 'no_permission' };
      if (m.releaseDate === to) return { ...base, outcome: 'same' };
      return { ...base, outcome: 'moves' };
    });
  const list = (to: string, changed: boolean, from: string | null): MoveAnswer => ({
    from,
    to,
    version,
    lines: lines(to),
    hidden: { releases: hiddenReleases },
    changed,
  });
  const candidates: Candidate[] = [
    {
      id: 31,
      name: '2.1',
      startDate: null,
      releaseDate: '2026-12-15',
      track: SHOP,
    },
    {
      id: 32,
      name: '3.0',
      startDate: null,
      releaseDate: null,
      track: { id: 3, key: 'WEB', name: 'Website' },
    },
  ];
  return {
    moved: () => lastMove,
    unlinked: () => removed,
    list: async (wanted) => ({
      releases: !exists || (wanted === 'shipped') !== (options.shipped ?? false) ? [] : [row()],
      next: null,
    }),
    candidates: async () => ({ releases: candidates, truncated: false }),
    get: async (id) => {
      if (id !== 5 || !exists) throw new Error('not_found');
      return answer();
    },
    create: async (input: NewCrossTrack) => {
      exists = true;
      name = input.name;
      description = input.description ?? '';
      endRule = input.endRule;
      date = input.date ?? null;
      members = candidates
        .filter((c) => input.releaseIds.includes(c.id))
        .map((c) => linked(c.id, c.name, c.track, c.releaseDate));
      refreshSteps();
      return { ok: true, value: answer() };
    },
    update: async (_id, input) => {
      if (input.version !== version) return { ok: false, code: 'version_conflict', version };
      name = input.name ?? name;
      description = input.description ?? description;
      if (input.endRule) {
        endRule = 'work_complete';
        date = null;
      }
      version++;
      refreshSteps();
      return { ok: true, value: answer() };
    },
    remove: async () => {
      exists = false;
      return { ok: true, value: null };
    },
    changes: async (_id, to) => {
      if (options.shipped) return { ok: false, code: 'already_shipped' };
      return { ok: true, value: list(to, false, date) };
    },
    move: async (_id, to, given) => {
      if (stale) {
        stale = false;
        version++;
        return { ok: false, code: 'version_conflict', version };
      }
      if (given !== version) return { ok: false, code: 'version_conflict', version };
      const from = date;
      const happened = list(to, true, from);
      members = members.map((m) =>
        happened.lines.find((l) => l.id === m.id)?.outcome === 'moves'
          ? { ...m, releaseDate: to }
          : m,
      );
      date = to;
      endRule = 'fixed_date';
      version++;
      lastMove = to;
      refreshSteps();
      return { ok: true, value: { ...happened, version } };
    },
    link: async (_id, releaseId) => {
      const found = candidates.find((c) => c.id === releaseId);
      if (!found) return { ok: false, code: 'not_found' };
      if (members.some((m) => m.track.id === found.track.id)) {
        return { ok: false, code: 'track_taken' };
      }
      members = [...members, linked(found.id, found.name, found.track, found.releaseDate)];
      version++;
      refreshSteps();
      return { ok: true, value: answer() };
    },
    unlink: async (_id, releaseId) => {
      removed.push(releaseId);
      members = members.filter((m) => m.id !== releaseId);
      version++;
      return { ok: true, value: null };
    },
  };
}

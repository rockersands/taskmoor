import type {
  Approver,
  Outcome,
  Release,
  ReleaseClient,
  ReleaseNotes,
  ReleaseOverview,
} from './client';

/**
 * An in-memory track of releases for stories and tests (M1-050): Checkout 2.0 upcoming and past
 * its date with approvals waiting on Dave, 2.1 upcoming, 1.9 shipped, 1.8 archived. Shipping,
 * approvals and new releases change it as the server would; open tickets refuse to ship until
 * the call says where they go.
 */
const release = (
  id: number,
  name: string,
  extra: Partial<Release>,
  progress: Release['progress'] = { tickets: 0, closed: 0, open: 0 },
): Release => ({
  id,
  trackId: 1,
  name,
  description: '',
  startDate: null,
  releaseDate: null,
  order: id,
  shipped: false,
  shippedAt: null,
  archived: false,
  archivedAt: null,
  requireApprovals: false,
  progress,
  overdue: false,
  ...extra,
});

const counted = (query: string, count: number) => ({ query, count, exact: true });

export function fakeReleaseClient(
  options: { mayManage?: boolean; approver?: boolean } = {},
): ReleaseClient & { releases: () => Release[] } {
  const mayManage = options.mayManage ?? true;
  let next = 10;
  let releases: Release[] = [
    release(
      2,
      '2.0',
      {
        description: 'Cards and refunds.',
        releaseDate: '2026-10-15',
        requireApprovals: true,
        overdue: true,
      },
      { tickets: 4, closed: 1, open: 3 },
    ),
    release(3, '2.1', { releaseDate: '2026-12-01' }, { tickets: 1, closed: 0, open: 1 }),
    release(
      1,
      '1.9',
      {
        shipped: true,
        shippedAt: '2026-10-01T09:00:00Z',
        releaseDate: '2026-10-01',
        order: 0,
      },
      { tickets: 3, closed: 3, open: 0 },
    ),
    release(4, '1.8', { shipped: true, archived: true, releaseDate: '2026-08-01' }),
  ];
  let approvers: Approver[] = [
    { user: { id: 7, name: 'Dave Approver' }, decision: null, comment: '', decidedAt: null },
  ];
  const find = (id: number) => {
    const found = releases.find((r) => r.id === id);
    if (!found) throw new Error('not_found');
    return found;
  };
  const base = (id: number) => `targetRelease = ${id}`;
  const overview = (id: number): ReleaseOverview => {
    const r = find(id);
    const open = r.progress.open;
    const active = Math.min(open, 1);
    const waiting = approvers.filter((a) => a.decision !== 'approved').length;
    const declined = approvers.filter((a) => a.decision === 'declined').length;
    return {
      stages: {
        new: counted(`${base(id)} AND stage = new`, open - active),
        active: counted(`${base(id)} AND stage = active`, active),
        closed: counted(`${base(id)} AND stage = closed`, r.progress.closed),
      },
      open: counted(`${base(id)} AND stage != closed`, open),
      warnings: [
        ...(r.overdue && open > 0
          ? [{ code: 'overdue' as const, count: open, query: `${base(id)} AND stage != closed` }]
          : []),
        ...(r.shipped && open > 0
          ? [
              {
                code: 'open_after_ship' as const,
                count: open,
                query: `${base(id)} AND stage != closed`,
              },
            ]
          : []),
        ...(r.requireApprovals && !r.shipped && declined > 0
          ? [{ code: 'approval_declined' as const, count: declined }]
          : r.requireApprovals && !r.shipped && waiting > 0
            ? [{ code: 'approvals_waiting' as const, count: waiting }]
            : []),
      ],
      approvers: r.requireApprovals ? structuredClone(approvers) : [],
      tickets:
        id === 2
          ? [
              {
                id: 21,
                key: 'CHK-21',
                summary: 'Pay by card',
                type: 'Feature',
                status: 'Closed',
                stage: 'closed',
                assignee: 'Ana Lead',
              },
              {
                id: 22,
                key: 'CHK-22',
                summary: 'Save a card',
                type: 'Feature',
                status: 'Active',
                stage: 'active',
                assignee: 'Ana Lead',
              },
              {
                id: 23,
                key: 'CHK-23',
                summary: 'Refunds',
                type: 'Feature',
                status: 'New',
                stage: 'new',
                assignee: null,
              },
              {
                id: 24,
                key: 'CHK-24',
                summary: 'Gift cards',
                type: 'Chore',
                status: 'New',
                stage: 'new',
                assignee: 'Ana Lead',
              },
            ]
          : [],
      truncated: false,
      viewer: {
        mayManage,
        approver:
          options.approver && r.requireApprovals
            ? { decision: approvers[0]?.decision ?? null }
            : null,
      },
    };
  };
  const notes = (id: number): ReleaseNotes => {
    const r = find(id);
    const sections =
      r.progress.closed === 0
        ? []
        : [
            {
              type: 'Feature',
              tickets: [
                { id: 21, key: 'CHK-21', summary: 'Pay by card' },
                { id: 25, key: 'CHK-25', summary: 'A card form' },
              ],
            },
            { type: 'Bug', tickets: [{ id: 26, key: 'CHK-26', summary: 'Totals off by a cent' }] },
          ];
    const shippedOn = r.shipped ? (r.releaseDate ?? null) : null;
    return {
      release: {
        id,
        name: r.name,
        track: { id: 1, key: 'CHK', name: 'Checkout' },
        releaseDate: r.releaseDate,
        shipped: r.shipped,
        shippedOn,
      },
      sections,
      leftOut: sections.length > 0 ? [{ reason: 'Duplicate', count: 1 }] : [],
      truncated: false,
      markdown: [
        `# Checkout ${r.name}`,
        '',
        ...sections.flatMap((s) => [
          `## ${s.type}`,
          '',
          ...s.tickets.map((k) => `- ${k.key} ${k.summary}`),
          '',
        ]),
      ].join('\n'),
    };
  };
  return {
    releases: () => releases,
    track: async (key) => {
      if (key !== 'CHK') throw new Error('not_found');
      return { id: 1, key: 'CHK', name: 'Checkout' };
    },
    list: async () => ({ releases: structuredClone(releases), mayManage }),
    create: async (_trackId, made): Promise<Outcome> => {
      if (releases.some((r) => r.name === made.name)) return { ok: false, code: 'name_taken' };
      releases = [
        ...releases,
        release(++next, made.name, { releaseDate: made.releaseDate ?? null, order: next }),
      ];
      return { ok: true };
    },
    get: async (id) => ({ ...structuredClone(find(id)), approvers: structuredClone(approvers) }),
    overview: async (id) => overview(id),
    notes: async (id) => notes(id),
    ship: async (id, { releaseDate, moveOpenTo }): Promise<Outcome> => {
      const r = find(id);
      if (r.requireApprovals && approvers.some((a) => a.decision !== 'approved')) {
        return { ok: false, code: 'approvals_pending' };
      }
      if (r.progress.open > 0 && moveOpenTo === undefined) {
        return { ok: false, code: 'open_tickets', openTickets: r.progress.open };
      }
      const open = r.progress.open;
      releases = releases.map((x) =>
        x.id === id
          ? {
              ...x,
              shipped: true,
              shippedAt: `${releaseDate}T12:00:00Z`,
              releaseDate,
              overdue: false,
              progress: moveOpenTo
                ? { tickets: x.progress.closed, closed: x.progress.closed, open: 0 }
                : x.progress,
            }
          : x.id === moveOpenTo
            ? {
                ...x,
                progress: {
                  tickets: x.progress.tickets + open,
                  closed: x.progress.closed,
                  open: x.progress.open + open,
                },
              }
            : x,
      );
      return { ok: true };
    },
    decide: async (_id, decision, comment): Promise<Outcome> => {
      approvers = approvers.map((a) => ({
        ...a,
        decision,
        comment,
        decidedAt: '2026-10-29T10:00:00Z',
      }));
      return { ok: true };
    },
  };
}

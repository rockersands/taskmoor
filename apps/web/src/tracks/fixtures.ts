import { BOARD } from '../boards/fixtures';
import type { SummaryItem, TrackClient, TrackSummary } from './client';

/** A track's summary for stories and tests (M1-064): made up, its parts adding up. */
const item = (id: string, name: string | null, query: string, count: number): SummaryItem => ({
  id,
  name,
  query,
  count,
  exact: true,
});

export const SHOP_SUMMARY: TrackSummary = {
  track: { id: 1, key: 'SHOP', name: 'Shop' },
  overview: [
    item('open', null, 'track = SHOP AND closeReason IS EMPTY', 26),
    item('created', null, 'track = SHOP AND created >= -7d', 9),
    item('closed', null, 'track = SHOP AND closed >= -7d', 7),
    item('updated', null, 'track = SHOP AND updated >= -7d', 15),
    item('due', null, 'track = SHOP AND closeReason IS EMPTY AND due <= 7d', 4),
  ],
  stages: [
    item('new', 'new', 'track = SHOP AND stage = new', 14),
    item('active', 'active', 'track = SHOP AND stage = active', 12),
    item('closed', 'closed', 'track = SHOP AND stage = closed', 120),
  ],
  priorities: [
    item('High', 'High', 'track = SHOP AND closeReason IS EMPTY AND priority = "High"', 8),
    item('Medium', 'Medium', 'track = SHOP AND closeReason IS EMPTY AND priority = "Medium"', 12),
    item('none', null, 'track = SHOP AND closeReason IS EMPTY AND priority IS EMPTY', 6),
  ],
  types: [
    item('Bug', 'Bug', 'track = SHOP AND closeReason IS EMPTY AND type = "Bug"', 11),
    item('Feature', 'Feature', 'track = SHOP AND closeReason IS EMPTY AND type = "Feature"', 15),
  ],
  assignees: [
    item('2', 'Ada Lovelace', 'track = SHOP AND closeReason IS EMPTY AND assignee = 2', 10),
    item('3', 'Grace Hopper', 'track = SHOP AND closeReason IS EMPTY AND assignee = 3', 9),
    item('unassigned', null, 'track = SHOP AND closeReason IS EMPTY AND assignee IS EMPTY', 7),
  ],
};

export function fakeTrackClient(summary: TrackSummary | null = SHOP_SUMMARY): TrackClient {
  return {
    list: async () => [
      { key: 'SHOP', name: 'Shop', owner: { id: 1, name: 'Ada Lovelace' } },
      { key: 'WEB', name: 'Web', owner: null },
    ],
    board: async () => BOARD,
    files: async () => ({
      attachments: [
        {
          id: 1,
          name: 'invoice.pdf',
          size: 2048,
          createdAt: '2026-10-01T10:00:00Z',
          ticket: { key: 'SHOP-41', summary: 'Checkout fails for expired cards' },
        },
      ],
      links: [
        {
          id: 1,
          url: 'https://example.com/design',
          title: 'Design',
          ticket: { key: 'SHOP-40', summary: 'Card payments' },
        },
      ],
      truncated: false,
    }),
    summary: async () => {
      if (!summary) throw new Error('not_found');
      return summary;
    },
  };
}

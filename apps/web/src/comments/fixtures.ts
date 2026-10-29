import type { PmJson } from '@taskmoor/richtext';
import { ApiError } from '../api/client';
import type { Lock } from '../locks/useLockText';
import type {
  Audiences,
  Comment,
  CommentClient,
  CommentList,
  MentionWarning,
  Reaction,
} from './client';

const text = (...paragraphs: string[]): PmJson => ({
  type: 'doc',
  content: paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
});

export const ADA = { id: 1, name: 'Ada Lovelace' };
export const GRACE = { id: 2, name: 'Grace Hopper' };

/** A discussion on SHOP-41: open, edited, restricted to a role, and a reply with a link. */
export const COMMENTS: Comment[] = [
  {
    id: 101,
    author: GRACE,
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Reproduced with an expired Visa card. ' },
            { type: 'mention', attrs: { id: '1', label: 'Ada Lovelace' } },
            { type: 'text', text: ' can you look at the retry?' },
          ],
        },
      ],
    },
    visibility: null,
    version: 1,
    createdAt: '2026-10-20T09:15:00Z',
    updatedAt: '2026-10-20T09:15:00Z',
    edited: null,
    reactions: [
      { emoji: '👍', count: 2, mine: true },
      { emoji: '👀', count: 1, mine: false },
    ],
    can: { edit: false, delete: false },
  },
  {
    id: 102,
    author: ADA,
    body: text('The retry used the old token. Fixed on the branch; deploying after review.'),
    visibility: null,
    version: 2,
    createdAt: '2026-10-20T10:02:00Z',
    updatedAt: '2026-10-20T10:40:00Z',
    edited: { at: '2026-10-20T10:40:00Z', by: ADA },
    reactions: [],
    can: { edit: true, delete: true },
  },
  {
    id: 103,
    author: ADA,
    body: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Card numbers from the logs are in the ' },
            {
              type: 'text',
              text: 'security runbook',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/runbook' } }],
            },
            { type: 'text', text: '.' },
          ],
        },
      ],
    },
    visibility: { roleId: 7, name: 'Administrators' },
    version: 1,
    createdAt: '2026-10-21T08:00:00Z',
    updatedAt: '2026-10-21T08:00:00Z',
    edited: null,
    reactions: [],
    can: { edit: true, delete: true },
  },
];

export const AUDIENCES: Audiences = {
  roles: [
    { id: 8, name: 'Members', held: true },
    { id: 7, name: 'Administrators', held: false },
    { id: 9, name: 'Viewers', held: false },
  ],
  groups: [{ id: 21, name: 'Payments team' }],
};

export const STATUS_LOCK: Lock = {
  by: 'status',
  statusId: 4,
  statusName: 'Approved',
  allowed: [{ type: 'role', id: 7, name: 'Administrators' }],
};

export interface FakeCommentClient extends CommentClient {
  /** What the client was asked to do, in order. */
  calls: { action: string; args: unknown[] }[];
}

/** An in-memory backend for stories and tests: it answers as the API would. */
export function fakeCommentClient(
  start: Partial<CommentList> & { failAdd?: ApiError; mentionWarnings?: MentionWarning[] } = {},
): FakeCommentClient {
  let comments = structuredClone(start.comments ?? COMMENTS);
  let nextId = 200;
  const calls: FakeCommentClient['calls'] = [];
  const me = ADA;
  return {
    calls,
    list: async (after) => {
      calls.push({ action: 'list', args: [after] });
      return {
        comments: structuredClone(comments),
        next: null,
        can: start.can ?? { add: true, react: true },
        lock: start.lock ?? null,
      };
    },
    add: async (body, visibility) => {
      calls.push({ action: 'add', args: [body, visibility] });
      if (start.failAdd) throw start.failAdd;
      const named =
        visibility === null
          ? null
          : 'roleId' in visibility
            ? {
                roleId: visibility.roleId,
                name: AUDIENCES.roles.find((r) => r.id === visibility.roleId)?.name ?? '',
              }
            : {
                groupId: visibility.groupId,
                name: AUDIENCES.groups.find((g) => g.id === visibility.groupId)?.name ?? '',
              };
      const now = new Date('2026-10-22T12:00:00Z').toISOString();
      const comment: Comment = {
        id: ++nextId,
        author: me,
        body,
        visibility: named,
        version: 1,
        createdAt: now,
        updatedAt: now,
        edited: null,
        reactions: [],
        can: { edit: true, delete: true },
      };
      comments = [...comments, comment];
      return start.mentionWarnings
        ? { ...structuredClone(comment), mentionWarnings: start.mentionWarnings }
        : structuredClone(comment);
    },
    edit: async (id, change) => {
      calls.push({ action: 'edit', args: [id, change] });
      const found = comments.find((c) => c.id === id);
      if (!found) throw new ApiError(404, { error: 'not_found' });
      const now = new Date('2026-10-22T12:30:00Z').toISOString();
      Object.assign(found, {
        ...(change.body ? { body: change.body } : {}),
        version: found.version + 1,
        edited: { at: now, by: me },
        updatedAt: now,
      });
      return structuredClone(found);
    },
    remove: async (id) => {
      calls.push({ action: 'remove', args: [id] });
      comments = comments.filter((c) => c.id !== id);
    },
    react: async (id, emoji, on) => {
      calls.push({ action: 'react', args: [id, emoji, on] });
      const found = comments.find((c) => c.id === id);
      if (!found) throw new ApiError(404, { error: 'not_found' });
      const list: Reaction[] = found.reactions;
      const existing = list.find((r) => r.emoji === emoji);
      if (on && !existing?.mine) {
        if (existing) Object.assign(existing, { count: existing.count + 1, mine: true });
        else list.push({ emoji, count: 1, mine: true });
      } else if (!on && existing?.mine) {
        existing.count -= 1;
        existing.mine = false;
        if (existing.count === 0) list.splice(list.indexOf(existing), 1);
      }
      return structuredClone(list);
    },
    audiences: async () => {
      calls.push({ action: 'audiences', args: [] });
      return structuredClone(AUDIENCES);
    },
  };
}

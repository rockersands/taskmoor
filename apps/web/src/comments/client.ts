import type { PmJson } from '@taskmoor/richtext';
import { api } from '../api/client';
import type { Lock } from '../locks/useLockText';

/** A restriction as the API names it: one role or one group, with its name. */
export type CommentVisibility =
  | { roleId: number; name: string }
  | { groupId: number; name: string }
  | null;
/** A restriction as a request gives it. */
export type VisibilityChoice = { roleId: number } | { groupId: number } | null;

export interface Reaction {
  emoji: string;
  count: number;
  /** Whether the reader is one of them. */
  mine: boolean;
}

/** A comment as `GET /api/v1/tickets/:id/comments` shows it (CORE-020). */
export interface Comment {
  id: number;
  author: { id: number; name: string } | null;
  body: PmJson;
  visibility: CommentVisibility;
  version: number;
  createdAt: string;
  updatedAt: string;
  edited: { at: string; by: { id: number; name: string } | null } | null;
  reactions: Reaction[];
  can: { edit: boolean; delete: boolean };
}

export interface CommentList {
  comments: Comment[];
  next: number | null;
  can: { add: boolean; react: boolean };
  /** The ticket's status keeps this person from commenting (WF-007). */
  lock: Lock | null;
}

export interface Audiences {
  roles: { id: number; name: string; held: boolean }[];
  groups: { id: number; name: string }[];
}

/** The endpoints the comments section uses for one ticket. Stories and tests pass their own. */
export interface CommentClient {
  list: (after?: number) => Promise<CommentList>;
  add: (body: PmJson, visibility: VisibilityChoice) => Promise<Comment>;
  edit: (id: number, change: { body?: PmJson; visibility?: VisibilityChoice }) => Promise<Comment>;
  remove: (id: number) => Promise<void>;
  react: (id: number, emoji: string, on: boolean) => Promise<Reaction[]>;
  audiences: () => Promise<Audiences>;
}

export function commentClient(ticket: number | string): CommentClient {
  const base = `/tickets/${encodeURIComponent(String(ticket))}`;
  return {
    list: (after) =>
      api<CommentList>(
        `${base}/comments?limit=100${after === undefined ? '' : `&cursor=${after}`}`,
      ),
    add: async (body, visibility) =>
      (
        await api<{ comment: Comment }>(`${base}/comments`, {
          method: 'POST',
          body: { body, visibility },
        })
      ).comment,
    edit: async (id, change) =>
      (await api<{ comment: Comment }>(`${base}/comments/${id}`, { method: 'PATCH', body: change }))
        .comment,
    remove: async (id) => {
      await api<unknown>(`${base}/comments/${id}`, { method: 'DELETE' });
    },
    react: async (id, emoji, on) =>
      (
        await api<{ reactions: Reaction[] }>(
          `${base}/comments/${id}/reactions/${encodeURIComponent(emoji)}`,
          { method: on ? 'PUT' : 'DELETE' },
        )
      ).reactions,
    audiences: () => api<Audiences>(`${base}/comment-audiences`),
  };
}

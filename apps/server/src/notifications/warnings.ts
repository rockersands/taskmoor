import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import type { Authorizer, AuthzContext } from '../authz/authorizer';
import type { TicketAccessRow } from '../authz/visibility';
import { type CommentAudienceRow, readsComment } from '../tickets/comments';
import { hasMentions, type Mentions } from './mentions';

/**
 * What a write answers about its mentions (M1-058; NTF-005 (1)): the people and teams it
 * mentioned who will not be told, because they may not see the ticket (`cannot_view`), may see
 * it but not read the restricted comment (`cannot_read`), or are no active person of the
 * workspace (`unknown`). For a team, `count` says how many of its members are left out. The
 * editor warns before saving (the `canView` flag of the mention list); this is the same warning
 * for the API and for what the editor could not know. Names go only to writers who may browse
 * users and groups, as the editor's mention list does; others get the ids alone.
 */
export interface MentionWarning {
  kind: 'user' | 'group';
  id: number;
  name: string;
  reason: 'cannot_view' | 'cannot_read' | 'unknown';
  count?: number;
}

/** Team members checked at most per team: a warning, not a census. */
const MEMBERS_CHECKED = 500;

export async function mentionWarnings(
  db: Kysely<Database>,
  authorizer: Authorizer,
  workspaceId: number,
  ticket: TicketAccessRow,
  mentions: Mentions | undefined,
  writer: Pick<AuthzContext, 'global'>,
  comment?: CommentAudienceRow,
): Promise<MentionWarning[]> {
  if (!hasMentions(mentions)) return [];
  const out = await warningsFor(db, authorizer, workspaceId, ticket, mentions, comment);
  if (out.length === 0 || (await writer.global()).has('browse_users')) return out;
  return out.map((w) => ({ ...w, name: '' }));
}

async function warningsFor(
  db: Kysely<Database>,
  authorizer: Authorizer,
  workspaceId: number,
  ticket: TicketAccessRow,
  mentions: Mentions,
  comment?: CommentAudienceRow,
): Promise<MentionWarning[]> {
  /** Whether a person hears of it: sees the ticket and, for a comment, reads it. */
  const judge = async (userId: number): Promise<'ok' | 'cannot_view' | 'cannot_read'> => {
    const held = await authorizer.ticketPermissions(workspaceId, { userId }, ticket);
    if (!held.has('browse_track')) return 'cannot_view';
    if (
      comment &&
      !(await readsComment(comment, userId, () =>
        authorizer.audience(workspaceId, userId, ticket.track_id),
      ))
    ) {
      return 'cannot_read';
    }
    return 'ok';
  };
  const out: MentionWarning[] = [];
  if (mentions.users.length > 0) {
    const people = new Map(
      (
        await db
          .selectFrom('app_user')
          .select(['id', 'name'])
          .where('workspace_id', '=', workspaceId)
          .where('deactivated_at', 'is', null)
          .where('id', 'in', mentions.users)
          .execute()
      ).map((p) => [p.id, p.name]),
    );
    for (const id of mentions.users) {
      const name = people.get(id);
      if (name === undefined) {
        out.push({ kind: 'user', id, name: '', reason: 'unknown' });
        continue;
      }
      const verdict = await judge(id);
      if (verdict !== 'ok') out.push({ kind: 'user', id, name, reason: verdict });
    }
  }
  for (const id of mentions.groups) {
    const group = await db
      .selectFrom('user_group')
      .select('name')
      .where('id', '=', id)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!group) {
      out.push({ kind: 'group', id, name: '', reason: 'unknown' });
      continue;
    }
    const { rows } = await sql<{ user_id: number }>`
      WITH RECURSIVE sub(id) AS (
        SELECT ${id}::int
        UNION
        SELECT n.child_id FROM group_nesting n JOIN sub ON n.parent_id = sub.id
         WHERE n.workspace_id = ${workspaceId}
      )
      SELECT DISTINCT m.user_id FROM group_member m
        JOIN app_user u ON u.id = m.user_id AND u.deactivated_at IS NULL
       WHERE m.group_id IN (SELECT id FROM sub)
       ORDER BY m.user_id LIMIT ${MEMBERS_CHECKED}`.execute(db);
    let views = 0;
    let reads = 0;
    for (const r of rows) {
      const verdict = await judge(r.user_id);
      if (verdict === 'cannot_view') views++;
      else if (verdict === 'cannot_read') reads++;
    }
    if (views > 0)
      out.push({ kind: 'group', id, name: group.name, reason: 'cannot_view', count: views });
    if (reads > 0)
      out.push({ kind: 'group', id, name: group.name, reason: 'cannot_read', count: reads });
  }
  return out;
}

/** The answer's `mentionWarnings`, present only when there is something to warn about. */
export const warningsField = (warnings: readonly MentionWarning[]) =>
  warnings.length > 0 ? { mentionWarnings: warnings } : {};

import type { Database, JsonValue } from '@taskmoor/db';
import { schema } from '@taskmoor/richtext';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';

/**
 * Comments (M1-018; CORE-020, NTF-001 (3); ADR-044): who may read a comment, the same rule on
 * every read path.
 *
 * A comment is open to everyone who may see its ticket, or restricted to one role (held in the
 * ticket's track) or one group (nested groups included). Its author always reads it. Nobody
 * else does, site administrators included (as for visibility levels, M1-020); administrators
 * read every comment's earlier versions through the versions route only. A deleted comment is
 * read by nobody but that route.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A comment's restriction: one role or one group, or null for an open comment. */
export type CommentVisibility = { roleId: number } | { groupId: number } | null;

export interface CommentAudienceRow {
  author_id: number | null;
  visible_role_id: number | null;
  visible_group_id: number | null;
  deleted_at?: Date | null;
}

export interface Audience {
  roleIds: ReadonlySet<number>;
  groupIds: ReadonlySet<number>;
}

export const visibilityOf = (row: CommentAudienceRow): CommentVisibility =>
  row.visible_role_id !== null
    ? { roleId: row.visible_role_id }
    : row.visible_group_id !== null
      ? { groupId: row.visible_group_id }
      : null;

export const isRestricted = (row: CommentAudienceRow) =>
  row.visible_role_id !== null || row.visible_group_id !== null;

/**
 * Whether a person reads a comment, given that they see its ticket: it is open, theirs, or for
 * a role they hold in the track or a group they are in. `audience` is asked for only when the
 * comment is restricted, so lists of open comments cost nothing more.
 */
export async function readsComment(
  row: CommentAudienceRow,
  userId: number | null,
  audience: () => Promise<Audience>,
): Promise<boolean> {
  if (row.deleted_at) return false;
  if (!isRestricted(row)) return true;
  if (userId !== null && row.author_id === userId) return true;
  const held = await audience();
  return row.visible_role_id !== null
    ? held.roleIds.has(row.visible_role_id)
    : held.groupIds.has(row.visible_group_id as number);
}

/** Asks for an audience once, however many comments need it. */
export function onceAudience(load: () => Promise<Audience>): () => Promise<Audience> {
  let pending: Promise<Audience> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

/**
 * The same rule as a SQL condition on a `ticket_comment` row aliased `c` whose ticket is joined
 * as `k`, for set-based readers (search and export, M1-037 and later). The reader must already
 * see the ticket, which this does not check. `track` names the ticket's track another way, for
 * a reader without `k` (the comments of `text ~`, M1-040).
 */
export function commentReadableSql(
  workspaceId: number,
  userId: number | null,
  track: RawBuilder<unknown> = sql`k.track_id`,
) {
  const open = sql<boolean>`(c.visible_role_id IS NULL AND c.visible_group_id IS NULL)`;
  if (userId === null) return sql<boolean>`(c.deleted_at IS NULL AND ${open})`;
  const groups = sql`(WITH RECURSIVE g(id) AS (
      SELECT group_id FROM group_member WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      UNION
      SELECT n.parent_id FROM group_nesting n JOIN g ON n.child_id = g.id
       WHERE n.workspace_id = ${workspaceId})
    SELECT id FROM g)`;
  return sql<boolean>`(c.deleted_at IS NULL AND (${open}
      OR c.author_id = ${userId}
      OR c.visible_group_id IN ${groups}
      OR c.visible_role_id IN (SELECT a.role_id FROM track_role_actor a
           WHERE a.track_id = ${track}
             AND (a.user_id = ${userId} OR a.group_id IN ${groups}))))`;
}

type DocNode = ReturnType<typeof schema.nodeFromJSON>;

/** What an inline or block leaf reads as in plain text. */
function leafText(leaf: DocNode): string {
  switch (leaf.type.name) {
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${leaf.attrs.label ?? leaf.attrs.id ?? ''}`;
    case 'ticketRef':
      return String(leaf.attrs.key ?? '');
    case 'attachmentRef':
      return String(leaf.attrs.name ?? '');
    default:
      return '';
  }
}

/**
 * A comment's text without formatting, for email: mentions as their names, blocks as lines, a
 * collapsible section as its title, then its text (ADR-120). The walk is `textBetween`'s, with
 * the section's title added: `textBetween` reads text and leaves only, never a block's attributes.
 */
export function commentText(body: JsonValue, max = 600): string {
  let text = '';
  try {
    const doc = schema.nodeFromJSON(body);
    let first = true;
    const line = (s: string) => {
      if (first) first = false;
      else text += '\n';
      text += s;
    };
    doc.descendants((node) => {
      if (node.isText) {
        text += node.text ?? '';
      } else if (node.type.name === 'expand') {
        const title = String(node.attrs.title ?? '').trim();
        if (title !== '') line(title);
      } else if (node.isLeaf) {
        const s = leafText(node);
        if (node.isBlock && s !== '') line(s);
        else text += s;
      } else if (node.isTextblock) {
        line('');
      }
      return !node.isLeaf;
    });
  } catch {
    return '';
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
}

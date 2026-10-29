/**
 * Mentions in rich text (M1-058; NTF-005; ADR-047). A mention is a node of the shared document
 * schema, `{ type: 'mention', attrs: { id, label } }`, in a description, the environment field
 * or a comment. Its id names a person (`"42"`, the editor's mention list) or a team, which is a
 * group (`"group:7"`). Other ids (an imported document's foreign account ids) name nobody here.
 *
 * Only mentions a change adds notify anyone: a document written for the first time mentions
 * everyone in it, an edit only those it did not mention before. People named in a People field
 * are not mentioned (NTF-005 (2)): only document nodes count.
 */
export interface Mentions {
  users: number[];
  groups: number[];
}

const MAX_ID = 2_147_483_647;
const USER = /^[1-9]\d{0,9}$/;
const GROUP = /^group:([1-9]\d{0,9})$/;
/** Mentions read from one document at most; a pasted wall of mentions notifies no more. */
export const MAX_MENTIONS = 200;
/** Nodes walked at most, so a hostile document cannot make the walk expensive. */
const MAX_NODES = 100_000;

export const noMentions = (): Mentions => ({ users: [], groups: [] });
export const hasMentions = (m: Mentions | undefined): m is Mentions =>
  m !== undefined && (m.users.length > 0 || m.groups.length > 0);

/** Every person and team a document mentions, each once, in document order. */
export function mentionsIn(doc: unknown): Mentions {
  const users = new Set<number>();
  const groups = new Set<number>();
  const stack: unknown[] = [doc];
  let walked = 0;
  while (stack.length > 0 && walked < MAX_NODES && users.size + groups.size < MAX_MENTIONS) {
    const node = stack.pop();
    walked++;
    if (node === null || typeof node !== 'object') continue;
    const { type, attrs, content } = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (type === 'mention' && attrs && typeof attrs === 'object') {
      const id = String((attrs as { id?: unknown }).id ?? '');
      const group = GROUP.exec(id)?.[1];
      if (USER.test(id) && Number(id) <= MAX_ID) users.add(Number(id));
      else if (group !== undefined && Number(group) <= MAX_ID) groups.add(Number(group));
    }
    if (Array.isArray(content)) {
      // Reversed onto the stack, so the walk keeps document order.
      for (let i = content.length - 1; i >= 0; i--) stack.push(content[i]);
    }
  }
  return { users: [...users], groups: [...groups] };
}

/** The mentions `after` has and `before` had not: what a change adds. */
export function addedMentions(before: unknown, after: unknown): Mentions {
  const was = mentionsIn(before);
  const now = mentionsIn(after);
  const users = new Set(was.users);
  const groups = new Set(was.groups);
  return {
    users: now.users.filter((id) => !users.has(id)),
    groups: now.groups.filter((id) => !groups.has(id)),
  };
}

/** Several sets of mentions as one, each person and team once. */
export function mergeMentions(...all: readonly Mentions[]): Mentions {
  return {
    users: [...new Set(all.flatMap((m) => m.users))],
    groups: [...new Set(all.flatMap((m) => m.groups))],
  };
}

/** The `mentions` an event payload carries, or nothing when the change added none. */
export const mentionPayload = (m: Mentions) => (hasMentions(m) ? { mentions: m } : {});

import type { JsonValue } from '@taskmoor/db';
import { fromWiki, toPlainText } from '@taskmoor/richtext';
import { canonicalJson } from '../tickets/model';
import type {
  StagedAttachment,
  StagedChange,
  StagedChangeItem,
  StagedComment,
  StagedLink,
  StagedWebLink,
  StagedWorklog,
} from './dc-backup/stage-issues';
import { instantOf } from './dc-fields';
import type { Mapped, Ref, StoredHistoryItem, Warning } from './model';

/**
 * The mapping of an issue's content from a Data Center backup (M1-091; IMP-004, IMP-010;
 * ADR-092): comments with their visibility and edits, change history with its original authors
 * and times, time entries, links between tickets, web links and attachments. Text is wiki
 * markup in the backup and becomes Taskmoor's documents through `fromWiki` (ADR-091); time
 * entries keep plain text, as Taskmoor's do. Anything left out or changed on the way is a
 * warning or the record's reason, so the report lists it.
 */

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });
const person = (id: string | null) => (id === null ? null : ref('user', id));

/** Wiki markup as a document; empty text is an empty paragraph. */
export function wikiDoc(text: string): JsonValue {
  return fromWiki(text.replace(/\r\n?/g, '\n')) as unknown as JsonValue;
}

/** Who may see a comment or time entry: a restriction that does not map fails the record. */
function visibility(
  v: { groupName: string | null; group: string | null; role: string | null; roleKnown: boolean },
  warnings: Warning[],
): { visibleGroup: Ref | null; visibleRole: Ref | null } | { fail: string } {
  // Leaving out a restriction would show the text more widely: such records fail instead.
  if (v.role !== null && !v.roleKnown) return { fail: 'visibility_role_missing' };
  if (v.groupName !== null && v.group === null) return { fail: 'visibility_group_missing' };
  if (v.role !== null && v.group !== null) {
    // Taskmoor restricts to one of them: the role, the narrower in a track.
    warnings.push({ code: 'visibility_group_and_role', detail: 'role kept' });
    return { visibleGroup: null, visibleRole: ref('role', v.role) };
  }
  return {
    visibleGroup: v.group === null ? null : ref('group', v.group),
    visibleRole: v.role === null ? null : ref('role', v.role),
  };
}

export function mapComment(c: StagedComment): Mapped {
  const createdAt = instantOf(c.created);
  if (createdAt === null) return { fail: 'no_time' };
  const warnings: Warning[] = [];
  const seen = visibility(c, warnings);
  if ('fail' in seen) return { fail: seen.fail };
  const updatedAt = instantOf(c.updated) ?? createdAt;
  const edited = updatedAt !== createdAt;
  return {
    command: {
      kind: 'comment',
      ticket: ref('ticket', c.issue),
      author: person(c.author),
      body: '',
      doc: wikiDoc(c.body),
      ...seen,
      createdAt,
      updatedAt,
      editedAt: edited ? updatedAt : null,
      editedBy: edited ? person(c.updateAuthor ?? c.author) : null,
    },
    warnings,
  };
}

export function mapTimeEntry(w: StagedWorklog): Mapped {
  const author = w.author ?? w.updateAuthor;
  if (author === null) return { fail: 'no_author' };
  const startedAt = instantOf(w.started) ?? instantOf(w.created);
  if (startedAt === null) return { fail: 'no_time' };
  if (w.seconds === null || w.seconds < 0) return { fail: 'no_duration' };
  const warnings: Warning[] = [];
  const seen = visibility(w, warnings);
  if ('fail' in seen) return { fail: seen.fail };
  const createdAt = instantOf(w.created) ?? startedAt;
  return {
    command: {
      kind: 'time_entry',
      ticket: ref('ticket', w.issue),
      author: ref('user', author),
      startedAt,
      seconds: w.seconds,
      // Time entries hold plain text: the markup's text without its marks.
      description: w.body === null ? '' : toPlainText(fromWiki(w.body)).trim(),
      ...seen,
      createdBy: ref('user', author),
      createdAt,
      updatedAt: instantOf(w.updated) ?? createdAt,
    },
    warnings,
  };
}

export function mapLink(l: StagedLink): Mapped {
  if (l.type === null) return { fail: 'link_type_missing' };
  if (l.source === l.destination) return { skip: 'link_to_itself' };
  return {
    command: {
      kind: 'link',
      source: ref('ticket', l.source),
      target: ref('ticket', l.destination),
      linkType: { name: l.type.name, outward: l.type.outward, inward: l.type.inward },
      // The backup keeps no time for links: the load takes the later ticket's creation.
      createdAt: null,
      creator: null,
    },
  };
}

const cut = (text: string, max: number, warnings: Warning[], what: string) => {
  if (text.length <= max) return text;
  warnings.push({ code: 'web_link_text_cut', detail: what });
  return text.slice(0, max);
};

export function mapWebLink(w: StagedWebLink): Mapped {
  const warnings: Warning[] = [];
  const url = w.url.trim();
  const title = w.title.trim() === '' ? url : w.title.trim();
  if (w.applicationName !== null || w.applicationType !== null) {
    // Taskmoor's web links keep the linked object's id, not the application it lives in.
    warnings.push({ code: 'web_link_application_not_kept' });
  }
  return {
    command: {
      kind: 'web_link',
      ticket: ref('ticket', w.issue),
      url,
      title: cut(title, 500, warnings, 'title'),
      summary: cut(w.summary ?? '', 2000, warnings, 'summary'),
      iconUrl: w.iconUrl,
      relationship: cut(w.relationship ?? '', 255, warnings, 'relationship'),
      globalId: w.globalId,
      // The backup keeps no time or author for web links (Verify): the import's time.
      createdAt: null,
      creator: null,
    },
    warnings,
  };
}

export function mapAttachment(a: StagedAttachment): Mapped {
  if (a.file === null) return { fail: 'attachment_file_missing' };
  const createdAt = instantOf(a.created);
  if (createdAt === null) return { fail: 'no_time' };
  const warnings: Warning[] = [];
  if (a.size !== null && a.size !== a.file.size) {
    warnings.push({ code: 'attachment_size_differs' });
  }
  if (a.file.folderKey !== null && a.issueKey !== null && a.file.folderKey !== a.issueKey) {
    warnings.push({ code: 'attachment_folder_key_differs' });
  }
  return {
    command: {
      kind: 'attachment',
      ticket: ref('ticket', a.issue),
      name: a.filename.trim() === '' ? `attachment-${a.id}` : a.filename.trim(),
      declaredType: a.mimetype ?? 'application/octet-stream',
      sniffedType: a.file.sniffed,
      size: a.file.size,
      sha256: a.file.sha256,
      author: person(a.author),
      createdAt,
      width: null,
      height: null,
      file: a.file.locator,
    },
    warnings,
  };
}

/**
 * The backup's system fields in history (format notes, "Comments, history ..."), named as
 * Taskmoor's history names them, and how each value is written: an id with its name for
 * display, text, a document, or a day.
 */
const SYSTEM_HISTORY: Readonly<
  Record<string, { field: string; value: 'id' | 'text' | 'doc' | 'day' | 'number' }>
> = {
  status: { field: 'status', value: 'id' },
  resolution: { field: 'closeReason', value: 'id' },
  priority: { field: 'priority', value: 'id' },
  issuetype: { field: 'type', value: 'id' },
  assignee: { field: 'assignee', value: 'id' },
  reporter: { field: 'requester', value: 'id' },
  project: { field: 'track', value: 'id' },
  key: { field: 'key', value: 'text' },
  summary: { field: 'summary', value: 'text' },
  description: { field: 'description', value: 'doc' },
  environment: { field: 'environment', value: 'doc' },
  duedate: { field: 'dueDate', value: 'day' },
  labels: { field: 'labels', value: 'text' },
  timeoriginalestimate: { field: 'originalEstimate', value: 'number' },
  timeestimate: { field: 'remainingEstimate', value: 'number' },
  timespent: { field: 'timeSpent', value: 'number' },
};

function historyItem(item: StagedChangeItem, warnings: Warning[]): StoredHistoryItem | null {
  if (item.fieldtype === 'custom') {
    if (!item.customField) {
      warnings.push({ code: 'history_field_not_mapped', detail: `custom:${item.field}` });
      return null;
    }
    // Choices keep their option ids as values; text, numbers and dates their text.
    return {
      field: `cf[${item.customField}]`,
      from: item.oldvalue ?? item.oldstring,
      to: item.newvalue ?? item.newstring,
      fromDisplay: item.oldvalue === null ? null : item.oldstring,
      toDisplay: item.newvalue === null ? null : item.newstring,
      transition: null,
    };
  }
  const system = SYSTEM_HISTORY[item.field.toLowerCase()];
  if (!system) {
    warnings.push({ code: 'history_field_not_mapped', detail: item.field });
    return null;
  }
  const value = (id: string | null, text: string | null): string | null => {
    switch (system.value) {
      case 'id':
      case 'number':
        return id;
      case 'text':
        return text;
      case 'doc':
        return text === null ? null : canonicalJson(wikiDoc(text));
      case 'day':
        return id === null ? null : id.trim().slice(0, 10);
    }
  };
  const display = (id: string | null, text: string | null, own: string | null | undefined) =>
    system.value === 'id' && id !== null ? (own ?? text) : null;
  return {
    field: system.field,
    from: value(item.oldvalue, item.oldstring),
    to: value(item.newvalue, item.newstring),
    fromDisplay: display(item.oldvalue, item.oldstring, item.oldDisplay),
    toDisplay: display(item.newvalue, item.newstring, item.newDisplay),
    transition: null,
  };
}

/**
 * A change group as one history entry, with its author and time: its items in stored form
 * with the backup's ids, which the load maps (`remap.ts`) and uses to correct the ticket's
 * starting values (ADR-010).
 */
export function mapHistory(h: StagedChange): Mapped {
  const at = instantOf(h.created);
  if (at === null) return { fail: 'no_time' };
  const warnings: Warning[] = [];
  const stored = h.items.flatMap((i) => {
    const mapped = historyItem(i, warnings);
    return mapped === null ? [] : [mapped];
  });
  if (stored.length === 0) return { skip: 'history_nothing_mapped', warnings };
  return {
    command: {
      kind: 'history',
      ticket: ref('ticket', h.issue),
      actor: person(h.author),
      at,
      items: [],
      stored,
    },
    warnings,
  };
}

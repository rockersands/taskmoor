import { CUSTOM_PREFIX } from '../notifications/model';

/**
 * Notification emails as text and HTML (M1-057; NTF-002): one ticket's changes gathered into
 * one email, or a digest of many tickets, and the track groups shared with the person (T-206). A
 * checklist notice (NTF-015) is one line for its run of changes, with no item's text. Every email links to its tickets, to the
 * notification settings and to a one-click unsubscribe. Strings come from `EMAIL_MESSAGES` per
 * locale (English only so far, which other locales fall back to); everything taken from data
 * is escaped in HTML.
 */
export interface EmailItem {
  event: string;
  actorName: string | null;
  /** Labels of the fields an update changed. */
  fields: string[];
  at: Date;
  /** A comment's text, for a comment the person may read (M1-018). */
  quote?: string;
  /** A checklist notice (NTF-015): how many changes, and how many other people made them. */
  checklist?: { changes: number; others: number };
}
export interface EmailTicket {
  key: string;
  summary: string;
  url: string;
  items: EmailItem[];
}
/** A track group shared with the person or set on them (T-206): never its tracks. */
export interface EmailGroupItem {
  how: 'shared' | 'set';
  name: string;
  actorName: string | null;
  role: string | null;
  at: Date;
}
/** The track groups an email tells of, and the Tracks page where they are. */
export interface EmailGroups {
  url: string;
  items: EmailGroupItem[];
}
export interface EmailLinks {
  settingsUrl: string;
  unsubscribeUrl: string;
}
export type EmailKind = 'instant' | 'daily' | 'weekly';

const EN = {
  'event.ticket_created': 'created the ticket',
  'event.ticket_updated': 'updated the ticket',
  'event.ticket_assigned': 'changed the assignee',
  'event.ticket_close_reason_set': 'set a close reason',
  'event.ticket_closed': 'closed the ticket',
  'event.ticket_commented': 'commented',
  'event.ticket_reopened': 'reopened the ticket',
  'event.ticket_deleted': 'moved the ticket to the trash',
  'event.ticket_moved': 'moved the ticket to another track',
  'event.time_entry_added': 'logged time',
  'event.time_entry_updated': 'changed logged time',
  'event.time_entry_deleted': 'deleted logged time',
  'event.work_started': 'started work',
  'event.work_stopped': 'stopped work',
  'event.generic': 'changed the ticket',
  'event.mentioned': 'mentioned you',
  'event.checklist_changed': 'changed a checklist',
  'event.checklistChanges': 'made {count} changes to checklists',
  'checklist.others': '{actor} and {others} more',
  'event.custom': 'fired {name}',
  someone: 'Someone',
  changed: 'Changed: {fields}',
  'subject.instant': '[{key}] {summary}',
  'subject.instantMany': '[{key}] {summary} ({count} changes)',
  'subject.daily': 'Your daily Taskmoor digest: {count} updates on {tickets} tickets',
  'subject.weekly': 'Your weekly Taskmoor digest: {count} updates on {tickets} tickets',
  'subject.dailyOther': 'Your daily Taskmoor digest: {count} updates',
  'subject.weeklyOther': 'Your weekly Taskmoor digest: {count} updates',
  'subject.groupShared': '{actor} shared the track group “{name}” with you',
  'subject.groupSet': '{actor} set the track group “{name}” on you',
  'subject.groups': '{count} track groups shared with you',
  'group.heading': 'Track groups',
  'group.shared': '{actor} shared the track group “{name}” with you.',
  'group.sharedRole': '{actor} shared the track group “{name}” with you, with the role {role}.',
  'group.set': '{actor} set the track group “{name}” on you: a copy of your own.',
  'group.setRole':
    '{actor} set the track group “{name}” on you: a copy of your own, with the role {role}.',
  'group.open': 'Open your tracks',
  'digest.intro': 'Here is what happened on the tickets you follow.',
  open: 'Open {key}',
  settings: 'Notification settings',
  unsubscribe: 'Unsubscribe',
  footer: 'You get this email because of your notification settings.',
} as const;
type MessageId = keyof typeof EN;
export const EMAIL_MESSAGES: Record<string, Record<MessageId, string>> = { en: EN };

function translator(locale: string | null) {
  const table = EMAIL_MESSAGES[(locale ?? 'en').split('-')[0] as string] ?? EN;
  return (id: MessageId, values: Record<string, string | number> = {}) =>
    (table[id] ?? EN[id]).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

function groupText(t: ReturnType<typeof translator>, item: EmailGroupItem): string {
  const values = { actor: item.actorName ?? t('someone'), name: item.name, role: item.role ?? '' };
  if (item.how === 'set') return t(item.role ? 'group.setRole' : 'group.set', values);
  return t(item.role ? 'group.sharedRole' : 'group.shared', values);
}

function eventText(t: ReturnType<typeof translator>, item: EmailItem): string {
  const who = item.actorName ?? t('someone');
  if (item.checklist) {
    // A run of checklist changes (NTF-015): who and how many, never what the items say.
    const { changes, others } = item.checklist;
    const people = others > 0 ? t('checklist.others', { actor: who, others }) : who;
    const did =
      changes > 1 ? t('event.checklistChanges', { count: changes }) : t('event.checklist_changed');
    return `${people} ${did}`;
  }
  const what = item.event.startsWith(CUSTOM_PREFIX)
    ? t('event.custom', { name: item.event.slice(CUSTOM_PREFIX.length) })
    : t(`event.${item.event}` as MessageId);
  return `${who} ${what || t('event.generic')}`;
}

/** The subject of an email that tells of track groups and no ticket. */
function groupsSubject(t: ReturnType<typeof translator>, items: readonly EmailGroupItem[]) {
  const only = items[0];
  if (items.length !== 1 || !only) return t('subject.groups', { count: items.length });
  const values = { actor: only.actorName ?? t('someone'), name: only.name };
  return t(only.how === 'set' ? 'subject.groupSet' : 'subject.groupShared', values);
}

export function renderEmail(
  kind: EmailKind,
  tickets: readonly EmailTicket[],
  links: EmailLinks,
  locale: string | null,
  groups: EmailGroups | null = null,
): { subject: string; text: string; html: string } {
  const t = translator(locale);
  const count = tickets.reduce((n, ticket) => n + ticket.items.length, 0);
  const groupItems = groups?.items ?? [];
  const first = tickets[0];
  const subject = !first
    ? kind === 'instant'
      ? groupsSubject(t, groupItems)
      : t(kind === 'weekly' ? 'subject.weeklyOther' : 'subject.dailyOther', {
          count: groupItems.length,
        })
    : kind === 'instant'
      ? first.items.length > 1
        ? t('subject.instantMany', { key: first.key, summary: first.summary, count })
        : t('subject.instant', { key: first.key, summary: first.summary })
      : t(`subject.${kind}`, { count, tickets: tickets.length });

  const text: string[] = [];
  const html: string[] = [];
  if (kind !== 'instant') {
    text.push(t('digest.intro'), '');
    html.push(`<p>${escapeHtml(t('digest.intro'))}</p>`);
  }
  for (const ticket of tickets) {
    text.push(`${ticket.key} ${ticket.summary}`);
    html.push(
      `<h2 style="font-size:16px;margin:16px 0 4px"><a href="${escapeHtml(ticket.url)}">${escapeHtml(
        ticket.key,
      )}</a> ${escapeHtml(ticket.summary)}</h2>`,
      '<ul style="margin:0;padding-left:20px">',
    );
    for (const item of ticket.items) {
      const line = eventText(t, item);
      const changed =
        item.fields.length > 0 ? t('changed', { fields: item.fields.join(', ') }) : '';
      text.push(`- ${line}${changed ? ` (${changed})` : ''}`);
      const quote = item.quote ?? '';
      if (quote) text.push(...quote.split('\n').map((l) => `  > ${l}`));
      html.push(
        `<li>${escapeHtml(line)}${changed ? `<br><span style="color:#555">${escapeHtml(changed)}</span>` : ''}${
          quote
            ? `<blockquote style="margin:4px 0;padding-left:8px;border-left:3px solid #ccc;white-space:pre-wrap">${escapeHtml(quote)}</blockquote>`
            : ''
        }</li>`,
      );
    }
    text.push(`${t('open', { key: ticket.key })}: ${ticket.url}`, '');
    html.push(
      '</ul>',
      `<p><a href="${escapeHtml(ticket.url)}">${escapeHtml(t('open', { key: ticket.key }))}</a></p>`,
    );
  }
  if (groups && groupItems.length > 0) {
    text.push(t('group.heading'));
    html.push(
      `<h2 style="font-size:16px;margin:16px 0 4px">${escapeHtml(t('group.heading'))}</h2>`,
      '<ul style="margin:0;padding-left:20px">',
    );
    for (const item of groupItems) {
      const line = groupText(t, item);
      text.push(`- ${line}`);
      html.push(`<li>${escapeHtml(line)}</li>`);
    }
    text.push(`${t('group.open')}: ${groups.url}`, '');
    html.push(
      '</ul>',
      `<p><a href="${escapeHtml(groups.url)}">${escapeHtml(t('group.open'))}</a></p>`,
    );
  }
  text.push(
    '--',
    t('footer'),
    `${t('settings')}: ${links.settingsUrl}`,
    `${t('unsubscribe')}: ${links.unsubscribeUrl}`,
  );
  html.push(
    `<hr><p style="color:#555;font-size:12px">${escapeHtml(t('footer'))} <a href="${escapeHtml(
      links.settingsUrl,
    )}">${escapeHtml(t('settings'))}</a> · <a href="${escapeHtml(links.unsubscribeUrl)}">${escapeHtml(
      t('unsubscribe'),
    )}</a></p>`,
  );
  return {
    subject,
    text: text.join('\n'),
    html: `<!doctype html><html><body style="font-family:sans-serif">${html.join('')}</body></html>`,
  };
}

/** What changed fields are called in emails; custom fields by their names. */
const FIELD_LABELS: Record<string, string> = {
  summary: 'Summary',
  description: 'Description',
  environment: 'Environment',
  ticketTypeId: 'Type',
  parentId: 'Parent',
  assigneeId: 'Assignee',
  requesterId: 'Requester',
  startDate: 'Start date',
  dueDate: 'Due date',
  originalEstimate: 'Original estimate',
  remainingEstimate: 'Remaining estimate',
  priorityId: 'Priority',
  closeReasonId: 'Close reason',
  visibilityLevelId: 'Visibility level',
  labels: 'Labels',
  targetReleaseIds: 'Target release',
  foundInReleaseIds: 'Found in release',
  areaIds: 'Area',
  duration: 'Time spent',
  startedAt: 'Started',
  visibility: 'Visibility',
};

export function fieldLabel(name: string, customNames: ReadonlyMap<number, string>): string {
  const custom = /^cf\[(\d+)\]$/.exec(name);
  if (custom) return customNames.get(Number(custom[1])) ?? name;
  return FIELD_LABELS[name] ?? name;
}

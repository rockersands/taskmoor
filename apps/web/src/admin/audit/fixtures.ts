import type { AuditClient, AuditRecord, SyslogSink } from './client';

export const RECORDS: AuditRecord[] = [
  {
    seq: 3,
    occurredAt: '2026-10-30T09:15:00Z',
    actor: { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
    action: 'token.created',
    subject: { type: 'api_token', id: '7' },
    details: {},
    ip: '203.0.113.5',
  },
  {
    seq: 2,
    occurredAt: '2026-10-30T09:00:00Z',
    actor: { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
    action: 'user.signed_in',
    subject: { type: 'user', id: '1', name: 'Ada Lovelace' },
    details: {},
    ip: '203.0.113.5',
  },
  {
    seq: 1,
    occurredAt: '2026-10-29T23:00:00Z',
    actor: null,
    action: 'backup.completed',
    subject: null,
    details: {},
    ip: null,
  },
];

/**
 * Records like those the page sweep saw (AD-2, S3-AD-1, S3-AD-4): a two-word name, long actions,
 * a role given to someone by name, refused password links and a changed password.
 */
export const SWEEP_RECORDS: AuditRecord[] = [
  {
    seq: 14,
    occurredAt: '2026-11-14T09:25:16Z',
    actor: null,
    action: 'password_link.rejected',
    subject: null,
    details: {},
    ip: '127.0.0.1',
  },
  {
    seq: 13,
    occurredAt: '2026-11-14T09:15:31Z',
    actor: { id: 2, name: 'Eval Admin', email: 'eval@example.com' },
    action: 'track_role.actor_added',
    subject: { type: 'track', id: '4', name: 'Operations' },
    details: { roleId: 3, userId: 9, groupId: null },
    about: { role: 'Developers', person: 'Noor Haddad' },
    ip: '100.88.0.12',
  },
  {
    seq: 12,
    occurredAt: '2026-11-14T09:14:29Z',
    actor: { id: 2, name: 'Eval Admin', email: 'eval@example.com' },
    action: 'ticket_template.created',
    subject: { type: 'ticket_template', id: '1', name: 'Sweep template' },
    details: {},
    ip: '127.0.0.1',
  },
  {
    seq: 11,
    occurredAt: '2026-11-14T09:14:29Z',
    actor: { id: 2, name: 'Eval Admin', email: 'eval@example.com' },
    action: 'user.password_changed',
    subject: { type: 'user', id: '9', name: 'Noor Haddad' },
    details: {},
    ip: '127.0.0.1',
  },
  {
    seq: 10,
    occurredAt: '2026-11-14T09:14:29Z',
    actor: { id: 2, name: 'Eval Admin', email: 'eval@example.com' },
    action: 'ticket.deleted',
    subject: { type: 'ticket', id: '209', name: 'MOB-12' },
    details: {},
    ip: '127.0.0.1',
  },
];

/** An in-memory audit API for stories and tests. */
export function fakeAuditClient(
  options: { records?: AuditRecord[]; pageSize?: number; brokenAt?: number } = {},
): AuditClient & { calls: string[] } {
  const records = options.records ?? RECORDS;
  const size = options.pageSize ?? 50;
  let months = 12;
  let sink: SyslogSink | null = null;
  const calls: string[] = [];
  return {
    calls,
    search: async (filter, cursor) => {
      calls.push(`search ${JSON.stringify(filter)} ${cursor ?? ''}`);
      const matching = records.filter((r) => !filter.action || r.action.startsWith(filter.action));
      const start = cursor ? matching.findIndex((r) => r.seq < Number(cursor)) : 0;
      const page = matching.slice(start, start + size);
      const last = page[page.length - 1];
      return {
        records: page,
        nextCursor: start + size < matching.length && last ? String(last.seq) : null,
      };
    },
    exportUrl: (filter, format, separator = 'comma') =>
      `/api/v1/audit/export?format=${format}${filter.action ? `&action=${filter.action}` : ''}${
        format === 'csv' && separator === 'semicolon' ? '&separator=semicolon' : ''
      }`,
    verify: async () => ({
      ok: options.brokenAt === undefined,
      checked: records.length,
      head: { seq: records[0]?.seq ?? 0 },
      firstBroken:
        options.brokenAt === undefined ? null : { seq: options.brokenAt, reason: 'hash_mismatch' },
    }),
    retention: async () => months,
    setRetention: async (m) => {
      months = m;
      return m;
    },
    syslog: async () => sink,
    setSyslog: async (next) => {
      sink = { ...next, lastSeq: 3, lastSentAt: null, lastError: null };
      return sink;
    },
    testSyslog: async (target) => {
      if (target.port === 1) throw new Error('unreachable');
    },
  };
}

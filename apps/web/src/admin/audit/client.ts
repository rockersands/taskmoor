import { API_BASE, api } from '../../api/client';

/** One audit record, as `GET /api/v1/audit` answers (M1-003; IAM-013). */
export interface AuditRecord {
  seq: number;
  occurredAt: string;
  actor: { id: number; name: string | null; email: string | null } | null;
  action: string;
  subject: { type: string; id: string | null } | null;
  details: unknown;
  ip: string | null;
}

export interface AuditFilter {
  /** A day, YYYY-MM-DD: records from its start. */
  from?: string | undefined;
  /** A day, YYYY-MM-DD: records before its end. */
  to?: string | undefined;
  /** An action or the start of one: `user.` finds every user event. */
  action?: string | undefined;
}

export interface ChainStatus {
  ok: boolean;
  checked: number;
  head: { seq: number };
  firstBroken: { seq: number; reason: string } | null;
}

export interface SyslogSink {
  enabled: boolean;
  host: string;
  port: number;
  transport: 'udp' | 'tcp' | 'tls';
  lastSeq: number;
  lastSentAt: string | null;
  lastError: string | null;
}

export type SyslogTarget = Pick<SyslogSink, 'host' | 'port' | 'transport'>;

export interface AuditClient {
  search: (
    filter: AuditFilter,
    cursor?: string,
  ) => Promise<{ records: AuditRecord[]; nextCursor: string | null }>;
  /** The address of the export download for the filter. */
  exportUrl: (filter: AuditFilter, format: 'csv' | 'jsonl') => string;
  verify: () => Promise<ChainStatus>;
  retention: () => Promise<number>;
  setRetention: (months: number) => Promise<number>;
  syslog: () => Promise<SyslogSink | null>;
  setSyslog: (sink: SyslogTarget & { enabled: boolean }) => Promise<SyslogSink | null>;
  testSyslog: (target: SyslogTarget) => Promise<void>;
}

/** The filter as query parameters; `to` is a day, so its end is the next day's start. */
export function filterParams(filter: AuditFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.from) params.set('from', filter.from);
  if (filter.to) {
    const next = new Date(`${filter.to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    params.set('to', next.toISOString().slice(0, 10));
  }
  if (filter.action?.trim()) params.set('action', filter.action.trim());
  return params;
}

export const auditClient: AuditClient = {
  search: (filter, cursor) => {
    const params = filterParams(filter);
    params.set('limit', '50');
    if (cursor) params.set('cursor', cursor);
    return api(`/audit?${params}`);
  },
  exportUrl: (filter, format) => {
    const params = filterParams(filter);
    params.set('format', format);
    return `${API_BASE}/audit/export?${params}`;
  },
  verify: () => api('/audit/verify'),
  retention: async () =>
    (await api<{ retentionMonths: number }>('/audit/settings')).retentionMonths,
  setRetention: async (months) =>
    (
      await api<{ retentionMonths: number }>('/audit/settings', {
        method: 'PUT',
        body: { retentionMonths: months },
      })
    ).retentionMonths,
  syslog: async () => (await api<{ syslog: SyslogSink | null }>('/audit/syslog')).syslog,
  setSyslog: async (sink) =>
    (await api<{ syslog: SyslogSink | null }>('/audit/syslog', { method: 'PUT', body: sink }))
      .syslog,
  testSyslog: async (target) => {
    await api('/audit/syslog/test', { method: 'POST', body: target });
  },
};

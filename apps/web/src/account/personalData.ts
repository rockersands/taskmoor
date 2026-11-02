import { API_BASE, api } from '../api/client';

/** A download of a person's data, as the server lists it (ASVS 8.3.2, ADR-111). */
export interface PersonalExport {
  id: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  requestedBy: number | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  size: number | null;
}

/** The endpoints of one person's downloads. Stories and tests pass their own. */
export interface PersonalDataClient {
  /** Whose data, when it is not the signed-in person's (a site administrator's view). */
  subject?: string;
  list: () => Promise<PersonalExport[]>;
  request: () => Promise<PersonalExport>;
  downloadUrl: (id: string) => string;
}

/** The list in an answer; anything else (an older backend, an empty answer) reads as none. */
const listOf = (answer: { exports?: PersonalExport[] } | null): PersonalExport[] =>
  Array.isArray(answer?.exports) ? answer.exports : [];

/** The signed-in person's own data. */
export const ownDataClient: PersonalDataClient = {
  list: async () =>
    listOf(await api<{ exports?: PersonalExport[] } | null>('/account/data-exports')),
  request: async () =>
    (await api<{ export: PersonalExport }>('/account/data-exports', { method: 'POST' })).export,
  downloadUrl: (id) => `${API_BASE}/account/data-exports/${encodeURIComponent(id)}/download`,
};

/** Someone's data, for a site administrator. */
export function personDataClient(userId: number, name: string): PersonalDataClient {
  const base = `/users/${userId}/data-exports`;
  return {
    subject: name,
    list: async () => listOf(await api<{ exports?: PersonalExport[] } | null>(base)),
    request: async () => (await api<{ export: PersonalExport }>(base, { method: 'POST' })).export,
    downloadUrl: (id) => `${API_BASE}${base}/${encodeURIComponent(id)}/download`,
  };
}

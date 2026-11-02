import { api } from '../api/client';

/** Attachment storage as the usage page shows it (M1-118; ASVS 12.1.3). */
export interface StorageSettings {
  maxFileSize: number;
  /** Bytes, or null for no quota (the default). */
  workspaceQuota: number | null;
  personQuota: number | null;
  usage: {
    bytes: number;
    files: number;
    topPerson: { id: number; name: string; bytes: number; files: number } | null;
  };
}

/** The endpoints the storage section uses. Stories and tests pass their own. */
export interface StorageClient {
  read: () => Promise<StorageSettings>;
  setQuotas: (quotas: {
    workspaceQuota: number | null;
    personQuota: number | null;
  }) => Promise<StorageSettings>;
}

export const storageClient: StorageClient = {
  read: () => api<StorageSettings>('/admin/attachment-settings'),
  setQuotas: (quotas) =>
    api<StorageSettings>('/admin/attachment-settings', { method: 'PUT', body: quotas }),
};

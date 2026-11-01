import { API_BASE, ApiError, api, apiFetch } from '../../api/client';

/**
 * The import wizard's calls (M1-097; IMP-013): runs, their reports and records, the imports
 * folder and uploads into it, and starting or cancelling a run. Everything is under
 * `/api/v1/admin/imports`, for site administrators.
 */
export type ImportSourceFormat = 'dc-backup' | 'taskmoor' | 'csv' | 'cloud-rest' | 'synthetic';
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type RecordOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'linked'
  | 'failed'
  | 'skipped'
  | 'deleted';

export interface KindProgress {
  kind: string;
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  linked: number;
  failed: number;
  skipped: number;
}

/** A run as `GET /api/v1/admin/imports/:id` shows it. */
export interface ImportRunView {
  id: number;
  importSource: string;
  sourceSystem: string;
  name: string;
  dryRun: boolean;
  status: RunStatus;
  cancelRequested: boolean;
  currentKind: string | null;
  deltaFrom: number | null;
  checkingDeletions: boolean;
  batches: number;
  progress: KindProgress[];
  unsupported: Record<string, number>;
  warnings: number;
  lastError: string | null;
  userId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ImportFileKind = 'dc-backup' | 'taskmoor' | 'csv' | null;

export interface ImportFile {
  name: string;
  size: number;
  modifiedAt?: string;
  kind: ImportFileKind;
}

export interface FilesView {
  /** Whether the server has an imports folder at all. */
  folder: boolean;
  files: ImportFile[];
  maxUpload: number;
}

export interface ImportRecord {
  kind: string;
  sourceId: string;
  label: string | null;
  outcome: RecordOutcome;
  targetId: number | null;
  reason: string | null;
  warnings: { code: string; detail?: string }[];
}

type Outcomes = Omit<KindProgress, 'kind' | 'read'>;

/** The fidelity report, the parts the wizard shows (the server's schema has them all). */
export interface FidelityReport {
  run: {
    id: number;
    importSource: string;
    sourceSystem: string;
    name: string;
    dryRun: boolean;
    status: 'done' | 'cancelled' | 'failed';
    startedAt: string | null;
    finishedAt: string;
    batches: number;
    deltaFrom?: number;
  };
  entities: {
    kind: string;
    source: number;
    outcomes: Outcomes;
    target: number | null;
    fidelity: number | null;
  }[];
  totals: { source: number; target: number | null; failed: number; fidelity: number | null };
  sampleSummary: { compared: number; matched: number; mismatched: number };
  warnings: {
    kind: string;
    code: string;
    detail: string | null;
    count: number;
    examples: string[];
  }[];
  unsupported: { kind: string; count: number; reason: string }[];
  failures: { kind: string; sourceId: string; error: string }[];
  failuresTruncated: boolean;
  mapping: {
    kind: string;
    sourceId: string;
    label: string | null;
    outcome: RecordOutcome;
    targetId: number | null;
    reason: string | null;
    warnings: string[];
  }[];
  mappingTruncated: boolean;
}

export interface PeopleRow {
  source: string;
  target: string;
}

export interface StartImport {
  name?: string;
  dryRun: boolean;
  deltaFrom?: number;
  source?: Record<string, unknown>;
}

export interface ImportsClient {
  runs(): Promise<ImportRunView[]>;
  run(id: number): Promise<ImportRunView>;
  report(id: number): Promise<FidelityReport>;
  records(
    id: number,
    query: { kind?: string; outcome?: RecordOutcome; limit?: number; after?: string },
  ): Promise<{ records: ImportRecord[]; next: string | null }>;
  files(): Promise<FilesView>;
  upload(file: File): Promise<ImportFile>;
  start(body: StartImport): Promise<ImportRunView>;
  cancel(id: number): Promise<ImportRunView>;
  /** Where the report downloads as a page. */
  reportUrl(id: number): string;
}

const query = (q: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const text = params.toString();
  return text ? `?${text}` : '';
};

export const importsClient: ImportsClient = {
  runs: async () => (await api<{ importRuns: ImportRunView[] }>('/admin/imports')).importRuns,
  run: async (id) => (await api<{ importRun: ImportRunView }>(`/admin/imports/${id}`)).importRun,
  report: async (id) =>
    (await api<{ report: FidelityReport }>(`/admin/imports/${id}/report`)).report,
  records: (id, q) =>
    api(`/admin/imports/${id}/records${query({ ...q })}`) as Promise<{
      records: ImportRecord[];
      next: string | null;
    }>,
  files: () => api<FilesView>('/admin/imports/files'),
  upload: async (file) => {
    const response = await apiFetch(
      `${API_BASE}/admin/imports/files${query({ name: file.name })}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      },
    );
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiError(response.status, body);
    return (body as { file: ImportFile }).file;
  },
  start: async (body) =>
    (await api<{ importRun: ImportRunView }>('/admin/imports', { method: 'POST', body })).importRun,
  cancel: async (id) =>
    (await api<{ importRun: ImportRunView }>(`/admin/imports/${id}/cancel`, { method: 'POST' }))
      .importRun,
  reportUrl: (id) => `${API_BASE}/admin/imports/${id}/report?format=html`,
};

import { ApiError } from '../../api/client';
import type {
  FidelityReport,
  FilesView,
  ImportFile,
  ImportRecord,
  ImportRunView,
  ImportsClient,
  StartImport,
} from './client';

/** Synthetic runs, reports and files for the wizard's stories and tests (M1-097). */
const at = '2026-10-31T09:00:00.000Z';

export const runView = (fields: Partial<ImportRunView> & Pick<ImportRunView, 'id'>) =>
  ({
    importSource: 'dc-backup',
    sourceSystem: 'dc',
    name: '',
    dryRun: false,
    status: 'done',
    cancelRequested: false,
    currentKind: null,
    deltaFrom: null,
    checkingDeletions: false,
    batches: 12,
    progress: [
      {
        kind: 'user',
        read: 20,
        created: 18,
        updated: 0,
        unchanged: 0,
        linked: 2,
        failed: 0,
        skipped: 0,
      },
      {
        kind: 'ticket',
        read: 300,
        created: 299,
        updated: 0,
        unchanged: 0,
        linked: 0,
        failed: 1,
        skipped: 0,
      },
    ],
    unsupported: {},
    warnings: 7,
    lastError: null,
    userId: 1,
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    ...fields,
  }) satisfies ImportRunView;

export const RUNS: ImportRunView[] = [
  runView({ id: 3, name: 'Friday changes', deltaFrom: 2 }),
  runView({ id: 2, name: 'Full import' }),
  runView({ id: 1, name: 'First look', dryRun: true }),
];

export const REPORT: FidelityReport = {
  run: {
    id: 2,
    importSource: 'dc-backup',
    sourceSystem: 'dc',
    name: 'Full import',
    dryRun: false,
    status: 'done',
    startedAt: at,
    finishedAt: at,
    batches: 12,
  },
  entities: [
    {
      kind: 'user',
      source: 20,
      outcomes: { created: 18, updated: 0, unchanged: 0, linked: 2, failed: 0, skipped: 0 },
      target: 20,
      fidelity: 1,
    },
    {
      kind: 'ticket',
      source: 300,
      outcomes: { created: 299, updated: 0, unchanged: 0, linked: 0, failed: 1, skipped: 0 },
      target: 299,
      fidelity: 0.9967,
    },
  ],
  totals: { source: 320, target: 319, failed: 1, fidelity: 0.9969 },
  sampleSummary: { compared: 30, matched: 30, mismatched: 0 },
  warnings: [
    { kind: 'ticket', code: 'type_not_offered', detail: '10002', count: 5, examples: ['10001'] },
    { kind: 'user', code: 'no_email', detail: null, count: 1, examples: ['JIRAUSER10004'] },
    {
      kind: 'workflow',
      code: 'condition_not_mapped',
      detail: 'Triage: Start',
      count: 1,
      examples: ['10100'],
    },
  ],
  unsupported: [{ kind: 'FilterSubscription', count: 3, reason: 'not_imported_yet' }],
  failures: [{ kind: 'ticket', sourceId: '10299', error: 'number_taken' }],
  failuresTruncated: false,
  mapping: [
    {
      kind: 'status',
      sourceId: '1',
      label: 'Backlog',
      outcome: 'linked',
      targetId: 4,
      reason: null,
      warnings: [],
    },
    {
      kind: 'status',
      sourceId: '10004',
      label: 'In Review',
      outcome: 'created',
      targetId: 12,
      reason: null,
      warnings: [],
    },
  ],
  mappingTruncated: false,
};

export const DELTA_REPORT: FidelityReport = {
  ...REPORT,
  run: { ...REPORT.run, id: 3, name: 'Friday changes', deltaFrom: 2 },
  entities: [
    {
      kind: 'ticket',
      source: 300,
      outcomes: { created: 0, updated: 5, unchanged: 295, linked: 0, failed: 0, skipped: 0 },
      target: 300,
      fidelity: 1,
    },
  ],
  totals: { source: 300, target: 300, failed: 0, fidelity: 1 },
  warnings: [
    { kind: 'comment', code: 'deleted_in_source', detail: null, count: 1, examples: ['10005'] },
    { kind: 'ticket', code: 'edited_in_target', detail: null, count: 1, examples: ['10007'] },
  ],
  unsupported: [],
  failures: [],
  mapping: [],
};

export const PEOPLE: ImportRecord[] = [
  {
    kind: 'user',
    sourceId: 'ada.lovelace',
    label: 'Ada Lovelace',
    outcome: 'linked',
    targetId: 2,
    reason: null,
    warnings: [],
  },
  {
    kind: 'user',
    sourceId: 'JIRAUSER10004',
    label: 'Grace Hopper',
    outcome: 'created',
    targetId: null,
    reason: null,
    warnings: [{ code: 'no_email' }],
  },
  {
    kind: 'user',
    sourceId: 'linus',
    label: 'Linus Pauling',
    outcome: 'created',
    targetId: null,
    reason: null,
    warnings: [],
  },
];

export const FILES: FilesView = {
  folder: true,
  maxUpload: 4 * 1024 ** 3,
  files: [
    { name: 'jira-backup-2026-10-30.zip', size: 18_400_000, kind: 'dc-backup' },
    { name: 'taskmoor-export-2026-10-29.zip', size: 2_100_000, kind: 'taskmoor' },
    { name: 'backlog.csv', size: 42_000, kind: 'csv' },
  ],
};

/**
 * A client that answers from the fixtures. A started run is queued, then running, then done on
 * the next calls (`ticks` polls in all), so the wizard follows it to its report.
 */
export function fakeImportsClient(
  options: {
    runs?: ImportRunView[];
    files?: FilesView;
    report?: FidelityReport;
    people?: ImportRecord[];
    ticks?: number;
    refuse?: string;
  } = {},
) {
  const runs = [...(options.runs ?? RUNS)];
  const files = structuredClone(options.files ?? FILES);
  const polls = new Map<number, number>();
  const started: StartImport[] = [];
  const uploaded: string[] = [];
  const cancelled: number[] = [];
  const ticks = options.ticks ?? 2;
  const client: ImportsClient = {
    runs: async () => runs,
    run: async (id) => {
      const run = runs.find((r) => r.id === id);
      if (!run) throw new ApiError(404, { error: 'not_found' });
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (run.status === 'queued' || run.status === 'running') {
        const next: ImportRunView = {
          ...run,
          status: run.cancelRequested ? 'cancelled' : n >= ticks ? 'done' : 'running',
          currentKind: n >= ticks ? null : 'ticket',
        };
        runs.splice(runs.indexOf(run), 1, next);
        return next;
      }
      return run;
    },
    report: async (id) => {
      const run = runs.find((r) => r.id === id);
      const base = options.report ?? (run?.deltaFrom ? DELTA_REPORT : REPORT);
      return {
        ...base,
        run: {
          ...base.run,
          id,
          dryRun: run?.dryRun ?? false,
          status: run?.status === 'cancelled' ? 'cancelled' : 'done',
        },
        totals: run?.dryRun ? { ...base.totals, target: null, fidelity: null } : base.totals,
      };
    },
    records: async () => ({ records: options.people ?? PEOPLE, next: null }),
    files: async () => files,
    upload: async (file: File) => {
      if (files.files.some((f) => f.name === file.name)) {
        throw new ApiError(409, { error: 'file_exists' });
      }
      const saved: ImportFile = {
        name: file.name,
        size: file.size,
        kind: file.name.endsWith('.csv') ? 'csv' : 'dc-backup',
      };
      files.files.push(saved);
      uploaded.push(file.name);
      return saved;
    },
    start: async (body) => {
      if (options.refuse) throw new ApiError(400, { error: options.refuse });
      started.push(body);
      const source = body.source as { format?: string } | undefined;
      const run = runView({
        id: Math.max(0, ...runs.map((r) => r.id)) + 1,
        name: body.name ?? '',
        dryRun: body.dryRun,
        status: 'queued',
        importSource: source?.format ?? 'cloud-rest',
        deltaFrom: body.deltaFrom ?? null,
        finishedAt: null,
      });
      runs.unshift(run);
      return run;
    },
    cancel: async (id) => {
      cancelled.push(id);
      const run = runs.find((r) => r.id === id) as ImportRunView;
      const next = { ...run, cancelRequested: true };
      runs.splice(runs.indexOf(run), 1, next);
      return next;
    },
    reportUrl: (id) => `#report-${id}`,
  };
  return Object.assign(client, { started, uploaded, cancelled });
}

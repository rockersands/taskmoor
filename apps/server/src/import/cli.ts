import { parseArgs } from 'node:util';
import { parsePeopleCsv } from './cloud/people';
import { CsvFormatError } from './csv';

/**
 * `node cli.mjs import ...` (M1-097; IMP-013): the import wizard's steps from a shell, against
 * a running server's API with an API token that has the admin scope (`TASKMOOR_URL`,
 * `TASKMOOR_TOKEN`), so it works from the server's container and from an administrator's own
 * machine alike, and the worker runs the import as it runs every other.
 *
 *   import start <source options> [--dry-run] [--name N] [--delta-from ID] [--follow]
 *                [--max-warnings N] [--interval S]
 *   import follow <id> [--max-warnings N] [--interval S]
 *   import report <id> [--json] [--html FILE] [--max-warnings N]
 *   import status <id> | import list | import cancel <id>
 *
 * Source options: `--source FILE` (the `source` object as JSON, any format), or one of
 * `--dc-backup PATH` (with `--scope`, `--system-admins`, `--system`), `--export PATH`,
 * `--csv PATH --mapping FILE`, `--cloud URL` (with `--email`, the token in
 * `TASKMOOR_SOURCE_TOKEN`, `--projects A,B`, `--jql`); `--people-map FILE` (two columns: the
 * person in the source, the Taskmoor address) maps people, everyone else by address. Paths are
 * inside the server's imports folder. Exit codes are `IMPORT_EXIT`.
 */
export const IMPORT_EXIT = {
  /** Done: nothing failed, and warnings within `--max-warnings` when it is given. */
  done: 0,
  /** The run failed or was cancelled. */
  failed: 1,
  /** Done, but records failed, or warnings above `--max-warnings`. */
  problems: 2,
  /** Bad usage: an unknown command or option, a missing value. */
  usage: 64,
  /** The server refused the request: a bad source, a file outside the folder, no such run. */
  refused: 65,
  /** The server could not be reached, or answered with an error of its own. */
  unavailable: 69,
  /** The report was asked for before the run finished. */
  notFinished: 75,
  /** The token is missing its admin scope or does not sign in. */
  forbidden: 77,
} as const;

// biome-ignore lint/suspicious/noExplicitAny: API bodies are read field by field
type Any = any;

export interface CliIo {
  /** One API call: path under `/api/v1`, JSON body. Throws when the server cannot be reached. */
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Any }>;
  out(line: string): void;
  err(line: string): void;
  sleep(ms: number): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  env: Readonly<Record<string, string | undefined>>;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const OPTIONS = {
  source: { type: 'string' },
  'dc-backup': { type: 'string' },
  export: { type: 'string' },
  csv: { type: 'string' },
  mapping: { type: 'string' },
  cloud: { type: 'string' },
  email: { type: 'string' },
  projects: { type: 'string' },
  jql: { type: 'string' },
  scope: { type: 'string' },
  'system-admins': { type: 'string' },
  system: { type: 'string' },
  'people-map': { type: 'string' },
  name: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'delta-from': { type: 'string' },
  follow: { type: 'boolean', default: false },
  'max-warnings': { type: 'string' },
  interval: { type: 'string' },
  json: { type: 'boolean', default: false },
  html: { type: 'string' },
} as const;

export const IMPORT_USAGE = [
  'Usage: node cli.mjs import <command>',
  '  start <source> [--dry-run] [--name N] [--delta-from ID] [--follow] [--max-warnings N]',
  '        source: --source FILE | --dc-backup PATH [--scope all|tickets|configuration]',
  '                [--system-admins site_admin|configuration_admin] [--system S]',
  '              | --export PATH | --csv PATH --mapping FILE',
  '              | --cloud URL [--email E] [--projects A,B] [--jql Q] (token in TASKMOOR_SOURCE_TOKEN)',
  '        [--people-map FILE]   people in the source to Taskmoor addresses, two columns',
  '  follow <id> [--max-warnings N] [--interval S]',
  '  report <id> [--json] [--html FILE] [--max-warnings N]',
  '  status <id> | list | cancel <id>',
  'Needs TASKMOOR_URL and TASKMOOR_TOKEN (an API token with the admin scope).',
  'Exit: 0 done, 1 failed or cancelled, 2 done with failures or too many warnings, 64 usage,',
  '      65 refused by the server, 69 server unreachable, 75 not finished, 77 not allowed.',
].join('\n');

const usage = (message: string) => new Exit(IMPORT_EXIT.usage, `${message}\n${IMPORT_USAGE}`);

const positiveInt = (text: string | undefined, what: string): number | null => {
  if (text === undefined) return null;
  if (!/^\d{1,9}$/.test(text)) throw usage(`${what} must be a whole number`);
  return Number(text);
};

/** The exit code of an answer that is not a success, with the server's reason. */
function refusal(res: { status: number; body: Any }, what: string): Exit {
  const reason = res.body?.error ?? `HTTP ${res.status}`;
  const detail = res.body?.message ? `: ${res.body.message}` : '';
  if (res.status === 401 || res.status === 403) {
    return new Exit(IMPORT_EXIT.forbidden, `${what}: ${reason} (the token needs the admin scope)`);
  }
  if (res.status >= 500) return new Exit(IMPORT_EXIT.unavailable, `${what}: ${reason}`);
  return new Exit(IMPORT_EXIT.refused, `${what}: ${reason}${detail}`);
}

async function call(io: CliIo, method: string, path: string, body?: unknown, what = path) {
  let res: { status: number; body: Any };
  try {
    res = await io.request(method, path, body);
  } catch (error) {
    throw new Exit(
      IMPORT_EXIT.unavailable,
      `${what}: the server cannot be reached (${(error as Error).message})`,
    );
  }
  if (res.status >= 400) throw refusal(res, what);
  return res.body;
}

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

/** The `source` object the options describe. */
async function sourceOf(values: Values, io: CliIo): Promise<Record<string, unknown> | null> {
  const given = (['source', 'dc-backup', 'export', 'csv', 'cloud'] as const).filter(
    (k) => values[k] !== undefined,
  );
  if (given.length > 1) throw usage(`give one source, not ${given.join(' and ')}`);
  let people: Record<string, unknown> | undefined;
  if (values['people-map'] !== undefined) {
    try {
      people = { mode: 'map', rows: parsePeopleCsv(await io.readFile(values['people-map'])) };
    } catch (error) {
      if (error instanceof CsvFormatError) throw usage(`--people-map: ${error.message}`);
      throw usage(`--people-map: ${(error as Error).message}`);
    }
  }
  const json = async (path: string, what: string) => {
    try {
      return JSON.parse(await io.readFile(path)) as Record<string, unknown>;
    } catch (error) {
      throw usage(`${what}: ${(error as Error).message}`);
    }
  };
  if (values.source !== undefined) {
    const source = await json(values.source, '--source');
    return people ? { ...source, people } : source;
  }
  if (values['dc-backup'] !== undefined) {
    const scope = values.scope ?? 'all';
    if (!['all', 'tickets', 'configuration'].includes(scope)) {
      throw usage('--scope is all, tickets or configuration');
    }
    const admins = values['system-admins'] ?? 'site_admin';
    if (!['site_admin', 'configuration_admin'].includes(admins)) {
      throw usage('--system-admins is site_admin or configuration_admin');
    }
    return {
      format: 'dc-backup',
      path: values['dc-backup'],
      scope,
      systemAdmins: admins,
      ...(values.system ? { system: values.system } : {}),
      ...(people ? { people } : {}),
    };
  }
  if (values.export !== undefined) return { format: 'taskmoor', path: values.export };
  if (values.csv !== undefined) {
    if (values.mapping === undefined) throw usage('--csv needs --mapping FILE');
    return {
      format: 'csv',
      path: values.csv,
      mapping: await json(values.mapping, '--mapping'),
      ...(values.system ? { system: values.system } : {}),
    };
  }
  if (values.cloud !== undefined) {
    const token = io.env.TASKMOOR_SOURCE_TOKEN;
    if (!token) throw usage('--cloud reads the site token from TASKMOOR_SOURCE_TOKEN');
    return {
      format: 'cloud-rest',
      baseUrl: values.cloud,
      token,
      ...(values.email ? { email: values.email } : {}),
      ...(values.projects
        ? {
            projects: values.projects
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean),
          }
        : {}),
      ...(values.jql ? { jql: values.jql } : {}),
      ...(values.system ? { system: values.system } : {}),
      ...(people ? { people } : {}),
    };
  }
  return null;
}

const count = (n: number) => n.toLocaleString('en');

/** One line of a run's progress. */
function progressLine(run: Any): string {
  const kinds = (run.progress ?? []) as Any[];
  const current = kinds.find((k) => k.kind === run.currentKind) ?? kinds[kinds.length - 1];
  const read = kinds.reduce((n: number, k: Any) => n + k.read, 0);
  const at = run.checkingDeletions
    ? 'checking what the source no longer has'
    : current
      ? `${current.kind} ${count(current.read)} read`
      : 'starting';
  return `import ${run.id} ${run.status}${run.dryRun ? ' (dry run)' : ''}: ${at}; ${count(read)} records so far, ${count(run.warnings)} warnings`;
}

/** The exit code of a finished run and its report. */
function outcomeOf(report: Any, maxWarnings: number | null): number {
  const status = report.run.status;
  if (status !== 'done') return IMPORT_EXIT.failed;
  const warnings = (report.warnings as Any[]).reduce((n, w) => n + w.count, 0);
  if (report.totals.failed > 0) return IMPORT_EXIT.problems;
  if (maxWarnings !== null && warnings > maxWarnings) return IMPORT_EXIT.problems;
  return IMPORT_EXIT.done;
}

/** The report as lines for a person: totals, kinds, warnings and failures. */
function summary(report: Any, maxWarnings: number | null): string[] {
  const r = report.run;
  const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(2)}%`);
  const out = [
    `import ${r.id} ${r.status}${r.dryRun ? ' (dry run)' : ''}${r.deltaFrom ? `, a delta from ${r.deltaFrom}` : ''}: ` +
      `${count(report.totals.source)} source records, ${report.totals.target === null ? 'none written' : `${count(report.totals.target)} in Taskmoor`}, ` +
      `${count(report.totals.failed)} failed, fidelity ${pct(report.totals.fidelity)}`,
  ];
  for (const e of report.entities as Any[]) {
    const o = e.outcomes;
    const parts = (
      ['created', 'updated', 'unchanged', 'linked', 'failed', 'skipped'] as const
    ).flatMap((k) => (o[k] > 0 ? [`${count(o[k])} ${k}`] : []));
    out.push(`  ${e.kind}: ${count(e.source)} read${parts.length ? `, ${parts.join(', ')}` : ''}`);
  }
  const warnings = report.warnings as Any[];
  const total = warnings.reduce((n, w) => n + w.count, 0);
  out.push(
    `warnings: ${count(total)}${maxWarnings === null ? '' : ` (at most ${count(maxWarnings)} wanted)`}`,
  );
  for (const w of warnings.slice(0, 30)) {
    out.push(
      `  ${w.kind} ${w.code}${w.detail ? ` (${w.detail})` : ''}: ${count(w.count)}${w.examples.length ? `, for example ${w.examples.join(', ')}` : ''}`,
    );
  }
  if (warnings.length > 30) out.push(`  and ${warnings.length - 30} more kinds of warning`);
  for (const u of report.unsupported as Any[]) {
    out.push(`not imported: ${u.kind} ${count(u.count)} (${u.reason})`);
  }
  for (const f of (report.failures as Any[]).slice(0, 20)) {
    out.push(`failed: ${f.kind} ${f.sourceId}: ${f.error}`);
  }
  return out;
}

/** Follows a run to its end, a line whenever its progress changes, then reports it. */
async function follow(io: CliIo, id: number, maxWarnings: number | null, interval: number) {
  let last = '';
  for (;;) {
    const run = (await call(io, 'GET', `/admin/imports/${id}`, undefined, `import ${id}`))
      .importRun as Any;
    const line = progressLine(run);
    if (line !== last) io.out(line);
    last = line;
    if (['done', 'failed', 'cancelled'].includes(run.status)) {
      if (run.lastError && run.status === 'failed') io.err(`import ${id}: ${run.lastError}`);
      return report(io, id, maxWarnings, false, null);
    }
    await io.sleep(interval);
  }
}

async function report(
  io: CliIo,
  id: number,
  maxWarnings: number | null,
  json: boolean,
  html: string | null,
): Promise<number> {
  let res: { status: number; body: Any };
  try {
    res = await io.request('GET', `/admin/imports/${id}/report`);
  } catch (error) {
    throw new Exit(
      IMPORT_EXIT.unavailable,
      `the server cannot be reached (${(error as Error).message})`,
    );
  }
  if (res.status === 409 && res.body?.error === 'not_finished') {
    throw new Exit(IMPORT_EXIT.notFinished, `import ${id} has not finished (${res.body.status})`);
  }
  if (res.status >= 400) throw refusal(res, `import ${id}`);
  const rep = res.body.report as Any;
  const code = outcomeOf(rep, maxWarnings);
  if (html !== null) {
    const page = await io.request('GET', `/admin/imports/${id}/report?format=html`);
    if (page.status >= 400) throw refusal(page, `import ${id}`);
    await io.writeFile(html, typeof page.body === 'string' ? page.body : String(page.body));
  }
  if (json) {
    io.out(JSON.stringify(rep));
  } else {
    for (const line of summary(rep, maxWarnings)) io.out(line);
    io.out(
      JSON.stringify({
        id,
        status: rep.run.status,
        exit: code,
        source: rep.totals.source,
        target: rep.totals.target,
        failed: rep.totals.failed,
        warnings: (rep.warnings as Any[]).reduce((n, w) => n + w.count, 0),
      }),
    );
  }
  return code;
}

const idOf = (text: string | undefined, command: string): number => {
  if (text === undefined || !/^[1-9]\d{0,17}$/.test(text)) {
    throw usage(`import ${command} needs the run's id`);
  }
  return Number(text);
};

/** Runs `import <args>`; returns the exit code. */
export async function importCommand(args: readonly string[], io: CliIo): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
    try {
      parsed = parseArgs({
        args: [...args],
        options: OPTIONS,
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw usage((error as Error).message);
    }
    const values = parsed.values as Values;
    const [command, ...rest] = parsed.positionals;
    if (command === undefined || command === 'help') {
      if (command === 'help') {
        io.out(IMPORT_USAGE);
        return IMPORT_EXIT.done;
      }
      throw usage('import needs a command');
    }
    const maxWarnings = positiveInt(values['max-warnings'], '--max-warnings');
    const intervalSeconds = positiveInt(values.interval, '--interval');
    const interval = (intervalSeconds ?? 2) * 1000;
    switch (command) {
      case 'start': {
        if (rest.length > 0) throw usage(`unexpected ${rest.join(' ')}`);
        const deltaFrom = positiveInt(values['delta-from'], '--delta-from');
        const source = await sourceOf(values, io);
        if (source === null && deltaFrom === null) throw usage('import start needs a source');
        const started = await call(
          io,
          'POST',
          '/admin/imports',
          {
            ...(values.name ? { name: values.name } : {}),
            dryRun: values['dry-run'] === true,
            ...(deltaFrom !== null ? { deltaFrom } : {}),
            ...(source ? { source } : {}),
          },
          'import start',
        );
        const run = started.importRun as Any;
        io.out(
          `import ${run.id} queued${run.dryRun ? ' (dry run)' : ''}: ${run.importSource} from ${run.sourceSystem}`,
        );
        if (!values.follow) {
          io.out(JSON.stringify({ id: run.id, status: run.status }));
          return IMPORT_EXIT.done;
        }
        return await follow(io, run.id, maxWarnings, interval);
      }
      case 'follow':
        return await follow(io, idOf(rest[0], 'follow'), maxWarnings, interval);
      case 'report':
        return await report(
          io,
          idOf(rest[0], 'report'),
          maxWarnings,
          values.json === true,
          values.html ?? null,
        );
      case 'status': {
        const id = idOf(rest[0], 'status');
        const run = (await call(io, 'GET', `/admin/imports/${id}`, undefined, `import ${id}`))
          .importRun;
        io.out(progressLine(run));
        io.out(JSON.stringify(run));
        return IMPORT_EXIT.done;
      }
      case 'list': {
        const runs = (await call(io, 'GET', '/admin/imports', undefined, 'import list'))
          .importRuns as Any[];
        for (const r of runs) {
          io.out(
            `${r.id}\t${r.status}${r.dryRun ? ' (dry run)' : ''}\t${r.importSource}\t${r.sourceSystem}\t${r.name}`,
          );
        }
        return IMPORT_EXIT.done;
      }
      case 'cancel': {
        const id = idOf(rest[0], 'cancel');
        const run = (await call(io, 'POST', `/admin/imports/${id}/cancel`, {}, `import ${id}`))
          .importRun;
        io.out(`import ${id}: cancel asked; it stops after its current batch`);
        io.out(JSON.stringify({ id, status: run.status }));
        return IMPORT_EXIT.done;
      }
      default:
        throw usage(`unknown import command ${command}`);
    }
  } catch (error) {
    if (error instanceof Exit) {
      io.err(error.message);
      return error.code;
    }
    throw error;
  }
}

/** The CLI's way to the API: `TASKMOOR_URL` with `TASKMOOR_TOKEN` as a Bearer token. */
export function httpRequest(baseUrl: string, token: string): CliIo['request'] {
  const base = baseUrl.replace(/\/+$/, '');
  return async (method, path, body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  };
}

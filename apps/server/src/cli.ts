// The backend's command line, shipped in the image as cli.mjs:
//   node cli.mjs upgrade [--dry-run]    the upgrade (OPS-006, M1-102): pre-flight checks, a
//        [--no-backup] [--unattended]   backup, the migrations, verification, rollback on any
//                                       failure. Exit 0 upgraded or up to date, 1 blocked or
//                                       failed with the database as before, 3 when the rollback
//                                       failed too. The last line is the report as JSON
//   node cli.mjs check-upgrade          pre-upgrade check (OPS-006); exit 1 while anything blocks
//   node cli.mjs frontends              frontends on other hosts, one origin a line (OPS-025)
//   node cli.mjs migrate                apply pending migrations and exit (no backup: the
//                                       advanced path; the server does this at start too)
//   node cli.mjs status                 migration status as JSON
//   node cli.mjs backup [--out <dir>]   database, files and config into <dir> (OPS-008); waits
//                                       while a scheduled backup runs
//   node cli.mjs restore <dir> --yes    put a backup back; stop the other roles first (OPS-009)
//   node cli.mjs drill [<dir>] [--keep] the restore drill (M1-101): restores the latest backup
//                                       (or <dir>) into a scratch database, checks every
//                                       table's rows, reports the time, drops it; exit 1 on a
//                                       mismatch
//   node cli.mjs purge-trash            deletes for good what outlived the trash retention
//   node cli.mjs field-values [--repair] checks the custom field side tables against the
//                                       tickets' values (M1-011); --repair rewrites the ones
//                                       that differ; exit 1 when some differ and are not repaired
//   node cli.mjs workflow-moves         checks for workflows whose published version has no
//        [--repair]                     transitions (T-237); migration 0107 gave every one its
//                                       free moves (T-246), so it finds only those free moves
//                                       leave alone; --repair gives any other its free moves as
//                                       a new published version; exit 1 when some are left
//                                       without
//   node cli.mjs export <dir>           the site in Taskmoor's export format (M1-098,
//        [--tracks KEY,KEY]             docs/export-format.md) into a new folder <dir>; the
//                                       last line is the manifest's summary as JSON
//   node cli.mjs checksum [--wait]      one checksum per table, for restore drills; --wait first
//                                       lets the worker finish relaying events and running jobs
//   node cli.mjs password-link <email>  a one-time link to set a password (an administrator who
//                                       is locked out, or after a lost password keyring)
//   node cli.mjs audit-verify           checks every site's audit hash chain (IAM-013);
//                                       exit 1 when one is broken
//   node cli.mjs allowlist-off          turns every site's IP allowlist off (M1-085), for
//                                       an administrator who locked themselves out
//   node cli.mjs mcp                    MCP over stdio for local MCP clients (M1-072): each line
//                                       is a JSON-RPC message sent to TASKMOOR_URL with the API
//                                       token in TASKMOOR_TOKEN; answers on stdout, logs on stderr
//   node cli.mjs import <command>       imports through a running server's API (M1-097):
//                                       start, follow, report, status, list, cancel, with
//                                       TASKMOOR_URL and TASKMOOR_TOKEN (admin scope). Exit 0
//                                       done, 1 failed or cancelled, 2 done with failures or
//                                       too many warnings, 64 usage, 65 refused, 69 server
//                                       unreachable, 75 not finished, 77 not allowed
//                                       (`node cli.mjs import help`; import/cli.ts)
//   node cli.mjs embeddings [--rebuild] embeds every ticket and comment without a current vector
//                                       (M1-078) with the bundled model (or the configured
//                                       endpoint), and sets pgvector's index up where offered;
//                                       --rebuild drops every vector first. One JSON line per
//                                       site with the counts and coverage
//   node cli.mjs report-verify          replays every ticket's report events (M1-059, RPT-003)
//                                       and compares them with the tickets; exit 1 when one
//                                       differs. Tickets older than the change history
//                                       (migration 0015) report as without history
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb, migrateToLatest, migrationStatus } from '@taskmoor/db';
import { attachmentStores } from './attachments/stores';
import { verifyChain } from './audit/chain';
import { backupSize, redactSecrets, restore, tableChecksums, waitForIdleQueue } from './backup';
import { latestBackup, recordedDrill } from './backups/drill';
import { BackupBusyError } from './backups/runs';
import { backupDirectory, backupWorkerState, recordedBackup } from './backups/schedule';
import { loadConfig } from './config';
import { createPasswordLink, passwordLinkUrl } from './directory';
import { backfillEmbeddings } from './embeddings/backfill';
import { EmbeddingService, embedderFor } from './embeddings/service';
import { emit } from './events/bus';
import { folderSink } from './export/sinks';
import { exportWorkspace } from './export/write';
import { FieldCatalogs } from './fields/catalog';
import { checkFieldValues } from './fields/jobs';
import { httpRequest, IMPORT_EXIT, importCommand } from './import/cli';
import { bridgeStdio } from './mcp/stdio';
import { replayCheck } from './reports/events';
import { purgeExpired } from './trash/purge';
import { otherFrontends } from './updates/check';
import { formatOutcome, upgrade, upgradeExitCode } from './upgrade';
import { checkUpgrade, formatChecks } from './upgrade-check';
import { repairWorkflowMoves } from './workflows/free-moves';
import { defaultWorkspaceId } from './workspace';

// Imports go through a running server's API (M1-097), with options of their own.
if (process.argv[2] === 'import') {
  const url = process.env.TASKMOOR_URL;
  const token = process.env.TASKMOOR_TOKEN;
  const args = process.argv.slice(3);
  if ((!url || !token) && args[0] !== 'help') {
    process.stderr.write('TASKMOOR_URL and TASKMOOR_TOKEN (admin scope) are required\n');
    process.exit(IMPORT_EXIT.usage);
  }
  const code = await importCommand(args, {
    request: httpRequest(url ?? '', token ?? ''),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data),
    env: process.env,
  });
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    yes: { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    repair: { type: 'boolean', default: false },
    rebuild: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    tracks: { type: 'string' },
    'no-backup': { type: 'boolean', default: false },
    unattended: { type: 'boolean', default: false },
  },
});
const command = positionals[0] ?? 'help';
const USAGE =
  'Usage: node cli.mjs <upgrade [--dry-run] [--no-backup] [--unattended] | check-upgrade | frontends | migrate | status | backup [--out dir] | restore <dir> --yes | drill [dir] [--keep] | purge-trash | field-values [--repair] | workflow-moves [--repair] | export <dir> [--tracks KEY,KEY] | checksum | password-link <email> | audit-verify | allowlist-off | report-verify | embeddings [--rebuild] | mcp | import <start|follow|report|status|list|cancel>>';

if (command === 'help' || command === '--help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

// The stdio bridge needs no database: it speaks to a running server.
if (command === 'mcp') {
  const url = process.env.TASKMOOR_URL;
  const token = process.env.TASKMOOR_TOKEN;
  if (!url || !token) {
    process.stderr.write('TASKMOOR_URL and TASKMOOR_TOKEN are required\n');
    process.exit(2);
  }
  await bridgeStdio({
    url,
    token,
    input: process.stdin,
    output: process.stdout,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(0);
}

const config = loadConfig({
  ...process.env,
  TASKMOOR_ROLE: process.env.TASKMOOR_ROLE ?? 'api',
});
if (!config.databaseUrl) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(2);
}
const databaseUrl = config.databaseUrl;
const dataDir = process.env.TASKMOOR_DATA;
const say = (message: string) => process.stdout.write(`${message}\n`);
const db = createDb({
  connectionString: databaseUrl,
  // The upgrade holds its lock on one connection while the backup and migrations use others.
  maxConnections: command === 'upgrade' ? 4 : 2,
  applicationName: 'taskmoor-cli',
});

try {
  switch (command) {
    case 'upgrade': {
      const backupState = backupWorkerState({ backupDir: config.backupDir, dataDir });
      const report = await upgrade(db, {
        databaseUrl,
        dataDir,
        backupRoot: backupDirectory({ backupDir: config.backupDir, dataDir }),
        ...(backupState === 'ready' ? {} : { backupDeclined: backupState }),
        version: config.version,
        config: {
          PUBLIC_URL: config.publicUrl,
          TASKMOOR_ROLE: config.roles.join(','),
          TASKMOOR_VERSION: config.version,
        },
        dryRun: values['dry-run'],
        noBackup: values['no-backup'],
        unattended: values.unattended,
        log: say,
      });
      process.stdout.write(formatOutcome(report));
      say(JSON.stringify(report));
      process.exitCode = upgradeExitCode(report.outcome);
      break;
    }
    case 'frontends': {
      // The frontends on other hosts (OPS-025): update.sh's last message names them.
      const origins = await otherFrontends(db, config.publicUrl, config.allowedOrigins);
      for (const origin of origins) say(origin);
      break;
    }
    case 'check-upgrade': {
      const checks = await checkUpgrade(db, dataDir ? { dataDir } : {});
      process.stdout.write(formatChecks(checks));
      if (checks.some((c) => c.state === 'block')) process.exitCode = 1;
      break;
    }
    case 'migrate': {
      const applied = await migrateToLatest(db);
      say(applied.length === 0 ? 'Up to date.' : `Applied: ${applied.join(', ')}`);
      break;
    }
    case 'status':
      say(JSON.stringify(await migrationStatus(db), null, 2));
      break;
    case 'backup': {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      // Where scheduled backups go (TASKMOOR_BACKUP_DIR), so the drill finds a backup taken by
      // hand; the data directory's backups folder when that is off or unset without one.
      const root =
        backupDirectory({ backupDir: config.backupDir, dataDir }) ??
        join(dataDir ?? '.', 'backups');
      const out = values.out ?? join(root, stamp);
      const target = {
        databaseUrl,
        ...(dataDir ? { dataDir } : {}),
        version: config.version,
        config: {
          PUBLIC_URL: config.publicUrl,
          TASKMOOR_ROLE: config.roles.join(','),
          TASKMOOR_VERSION: config.version,
        },
        log: say,
      };
      // One backup at a time: wait (up to an hour) for a scheduled one to finish.
      const deadline = Date.now() + 60 * 60_000;
      for (;;) {
        try {
          const { manifest } = await recordedBackup(db, 'manual', out, target);
          say(
            `${out}: ${Math.round(backupSize(out) / 1e6)} MB, ${manifest.migrations.length} migrations`,
          );
          break;
        } catch (error) {
          if (!(error instanceof BackupBusyError) || Date.now() > deadline) throw error;
          say('another backup is running; waiting for it to finish');
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      break;
    }
    case 'drill': {
      const root =
        backupDirectory({ backupDir: config.backupDir, dataDir }) ?? join('.', 'backups');
      const dir = positionals[1] ?? latestBackup(root);
      if (!dir) {
        process.stderr.write(`no backup found under ${root}; name one: node cli.mjs drill <dir>\n`);
        process.exitCode = 2;
        break;
      }
      const report = await recordedDrill(db, { databaseUrl, dir, keep: values.keep, log: say });
      say(
        `restore drill ${report.ok ? 'passed' : 'FAILED'}: ${report.tables} tables, ${report.rows} rows; ` +
          `verify ${report.seconds.verify} s, restore ${report.seconds.restore} s, ` +
          `check ${report.seconds.check} s, total ${report.seconds.total} s`,
      );
      if (!report.countsChecked) say('this backup holds no row counts (taken before M1-101)');
      for (const m of report.mismatches) {
        say(
          `  ${m.table}: ${m.expected ?? 'missing'} in the backup, ${m.actual ?? 'missing'} restored`,
        );
      }
      if (!report.migrationsMatch) say('  the restored migrations differ from the backup');
      say(JSON.stringify(report));
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'embeddings': {
      const embedder = embedderFor(config.embeddings);
      if (!embedder) {
        process.stderr.write('embeddings are off (TASKMOOR_EMBEDDINGS=off)\n');
        process.exitCode = 2;
        break;
      }
      const service = new EmbeddingService(
        db,
        embedder,
        config.vectorSearch === 'exact' ? { search: 'exact' } : {},
      );
      try {
        const reports = await backfillEmbeddings(db, service, {
          rebuild: values.rebuild,
          progress: say,
        });
        for (const report of reports) say(JSON.stringify(report));
      } finally {
        await embedder.close();
      }
      break;
    }
    case 'purge-trash': {
      const report = await purgeExpired(db);
      say(`purged ${report.tickets} ticket(s) and ${report.tracks} track(s)`);
      break;
    }
    case 'field-values': {
      const catalogs = new FieldCatalogs(db);
      const workspaces = await db
        .selectFrom('workspace')
        .select(['id', 'key'])
        .orderBy('id')
        .execute();
      for (const workspace of workspaces) {
        const run = await checkFieldValues(db, catalogs, workspace.id, { repair: values.repair });
        say(
          JSON.stringify({
            workspace: workspace.key,
            tickets: run.tickets,
            mismatched: run.mismatched.length,
            repaired: run.repaired.length,
            ...(run.mismatched.length > 0 ? { ticketIds: run.mismatched.slice(0, 100) } : {}),
          }),
        );
        if (run.mismatched.length > 0 && !values.repair) process.exitCode = 1;
      }
      break;
    }
    case 'workflow-moves': {
      const workspaces = await db
        .selectFrom('workspace')
        .select(['id', 'key'])
        .orderBy('id')
        .execute();
      for (const workspace of workspaces) {
        const run = await repairWorkflowMoves(db, workspace.id, { repair: values.repair });
        say(
          JSON.stringify({
            workspace: workspace.key,
            withoutMoves: run.found.length,
            repaired: run.repaired.length,
            ...(run.found.length > 0 ? { workflowIds: run.found } : {}),
          }),
        );
        if (run.repaired.length < run.found.length) process.exitCode = 1;
      }
      break;
    }
    case 'restore': {
      const dir = positionals[1];
      if (!dir) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        break;
      }
      if (!values.yes) {
        process.stderr.write(
          'restore replaces the database and the files; stop the other roles and add --yes to confirm\n',
        );
        process.exitCode = 2;
        break;
      }
      const manifest = await restore(db, dir, {
        databaseUrl,
        ...(dataDir ? { dataDir } : {}),
        log: say,
      });
      say(`restored a backup from ${manifest.createdAt} (version ${manifest.version})`);
      break;
    }
    case 'export': {
      const dir = positionals[1];
      if (!dir) {
        process.stderr.write('Usage: node cli.mjs export <dir> [--tracks KEY,KEY]\n');
        process.exitCode = 2;
        break;
      }
      // A new folder (or an empty one): an export never mixes with other files.
      await mkdir(dir, { recursive: true });
      if ((await readdir(dir)).length > 0) {
        process.stderr.write(`${dir} is not empty\n`);
        process.exitCode = 2;
        break;
      }
      const ws = await defaultWorkspaceId(db);
      let tracks: number[] | null = null;
      if (values.tracks) {
        const keys = values.tracks.split(',').map((k) => k.trim().toUpperCase());
        const rows = await db
          .selectFrom('track')
          .select(['id', 'key'])
          .where('workspace_id', '=', ws)
          .where('key', 'in', keys)
          .where('deleted_at', 'is', null)
          .execute();
        const unknown = keys.filter((k) => !rows.some((r) => r.key === k));
        if (unknown.length > 0) {
          process.stderr.write(`unknown tracks: ${unknown.join(', ')}\n`);
          process.exitCode = 2;
          break;
        }
        tracks = rows.map((r) => r.id);
      }
      const { manifest, ms } = await exportWorkspace(db, {
        workspaceId: ws,
        sink: folderSink(dir),
        stores: await attachmentStores(config),
        catalogs: new FieldCatalogs(db),
        tracks,
      });
      await emit(
        db,
        { workspaceId: ws, actorId: null },
        { type: 'workspace.exported', subjectId: ws, payload: { tracks: manifest.tracks } },
      );
      say(
        JSON.stringify({
          dir,
          seconds: Math.round(ms / 100) / 10,
          records: Object.fromEntries(manifest.files.map((f) => [f.kind, f.records])),
          attachments: manifest.attachments.files,
        }),
      );
      break;
    }
    case 'checksum':
      if (values.wait) await waitForIdleQueue(db);
      say(JSON.stringify(await tableChecksums(db), null, 2));
      break;
    case 'password-link': {
      const email = positionals[1]?.trim().toLowerCase();
      if (!email) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        break;
      }
      const workspaceId = await defaultWorkspaceId(db);
      const user = await db
        .selectFrom('app_user')
        .select(['id', 'password_hash', 'deactivated_at'])
        .where('workspace_id', '=', workspaceId)
        .where('email', '=', email)
        .where('kind', '=', 'person')
        .executeTakeFirst();
      if (!user || user.deactivated_at) {
        process.stderr.write(`no active account for ${email}\n`);
        process.exitCode = 1;
        break;
      }
      const purpose = user.password_hash ? 'reset' : 'activate';
      const link = await db.transaction().execute(async (trx) => {
        const created = await createPasswordLink(trx, {
          workspaceId,
          userId: user.id,
          purpose,
          createdBy: null,
        });
        await emit(
          trx,
          { workspaceId, actorId: null },
          {
            type: 'user.password_link_created',
            subjectId: user.id,
            payload: { purpose, expiresAt: created.expiresAt.toISOString() },
          },
        );
        return created;
      });
      say(passwordLinkUrl(config.publicUrl, link.token));
      say(`valid until ${link.expiresAt.toISOString()}; it works once`);
      break;
    }
    case 'audit-verify': {
      const workspaces = await db
        .selectFrom('workspace')
        .select(['id', 'key'])
        .orderBy('id')
        .execute();
      for (const workspace of workspaces) {
        const status = await verifyChain(db, workspace.id);
        say(JSON.stringify({ workspace: workspace.key, ...status }));
        if (!status.ok) process.exitCode = 1;
      }
      break;
    }
    case 'allowlist-off': {
      // From the server itself: the audit log records the change with no person as its actor.
      const turned = await db.transaction().execute(async (trx) => {
        const rows = await trx
          .updateTable('ip_allowlist')
          .set({ enabled: false, updated_at: new Date() })
          .where('enabled', '=', true)
          .returning(['workspace_id', 'exempt_group_ids'])
          .execute();
        for (const row of rows) {
          await emit(
            trx,
            { workspaceId: row.workspace_id, actorId: null },
            {
              type: 'ip_allowlist.updated',
              subjectId: row.workspace_id,
              payload: {
                enabled: { from: true, to: false },
                added: [],
                removed: [],
                exemptGroupIds: row.exempt_group_ids,
                lockoutConfirmed: false,
              },
            },
          );
        }
        return rows.length;
      });
      say(turned === 0 ? 'no allowlist was on' : `allowlist turned off in ${turned} site(s)`);
      break;
    }
    case 'report-verify': {
      const workspaces = await db
        .selectFrom('workspace')
        .select(['id', 'key'])
        .orderBy('id')
        .execute();
      for (const workspace of workspaces) {
        // Story points and other number fields are report facts too.
        const numberFields = (
          await db
            .selectFrom('field')
            .select('id')
            .where('workspace_id', '=', workspace.id)
            .where('type', '=', 'number')
            .execute()
        ).map((f) => f.id);
        const mismatches = await replayCheck(db, workspace.id, { numberFields });
        say(
          JSON.stringify({
            workspace: workspace.key,
            ok: mismatches.length === 0,
            mismatches: mismatches.length,
            first: mismatches.slice(0, 20),
          }),
        );
        if (mismatches.length > 0) process.exitCode = 1;
      }
      break;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
  }
} catch (error) {
  // Never print a connection password, whatever the error quotes.
  process.stderr.write(
    `${redactSecrets(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
} finally {
  await db.destroy();
}

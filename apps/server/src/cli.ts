// The backend's command line, shipped in the image as cli.mjs:
//   node cli.mjs check-upgrade          pre-upgrade check (OPS-006); exit 1 while anything blocks
//   node cli.mjs migrate                apply pending migrations and exit
//   node cli.mjs status                 migration status as JSON
//   node cli.mjs backup [--out <dir>]   database, files and config into <dir> (OPS-008)
//   node cli.mjs restore <dir> --yes    put a backup back; stop the other roles first (OPS-009)
//   node cli.mjs checksum [--wait]      one checksum per table, for restore drills; --wait first
//                                       lets the worker finish relaying events and running jobs
//   node cli.mjs password-link <email>  a one-time link to set a password (an administrator who
//                                       is locked out, or after a lost password keyring)
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb, migrateToLatest, migrationStatus } from '@taskmoor/db';
import { backup, backupSize, restore, tableChecksums, waitForIdleQueue } from './backup';
import { loadConfig } from './config';
import { createPasswordLink, passwordLinkUrl } from './directory';
import { emit } from './events/bus';
import { checkUpgrade, formatChecks } from './upgrade-check';
import { defaultWorkspaceId } from './workspace';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    yes: { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false },
  },
});
const command = positionals[0] ?? 'help';
const USAGE =
  'Usage: node cli.mjs <check-upgrade | migrate | status | backup [--out dir] | restore <dir> --yes | checksum | password-link <email>>';

if (command === 'help' || command === '--help') {
  process.stdout.write(`${USAGE}\n`);
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
  maxConnections: 2,
  applicationName: 'taskmoor-cli',
});

try {
  switch (command) {
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
      const out = values.out ?? join(dataDir ?? '.', 'backups', stamp);
      const manifest = await backup(db, out, {
        databaseUrl,
        ...(dataDir ? { dataDir } : {}),
        version: config.version,
        config: {
          PUBLIC_URL: config.publicUrl,
          TASKMOOR_ROLE: config.roles.join(','),
          TASKMOOR_VERSION: config.version,
        },
        log: say,
      });
      say(
        `${out}: ${Math.round(backupSize(out) / 1e6)} MB, ${manifest.migrations.length} migrations`,
      );
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
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
  }
} finally {
  await db.destroy();
}

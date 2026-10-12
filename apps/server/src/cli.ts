// The backend's command line, shipped in the image as cli.mjs:
//   node cli.mjs check-upgrade   pre-upgrade check (OPS-006); exit 1 while anything blocks
//   node cli.mjs migrate         apply pending migrations and exit (what the api role does at start)
//   node cli.mjs status          migration status as JSON
import { createDb, migrateToLatest, migrationStatus } from '@tracksmith/db';
import { loadConfig } from './config';
import { checkUpgrade, formatChecks } from './upgrade-check';

const command = process.argv[2] ?? 'help';
const USAGE = 'Usage: node cli.mjs <check-upgrade | migrate | status>';

if (command === 'help' || command === '--help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const config = loadConfig({
  ...process.env,
  TRACKSMITH_ROLE: process.env.TRACKSMITH_ROLE ?? 'api',
});
if (!config.databaseUrl) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(2);
}
const db = createDb({
  connectionString: config.databaseUrl,
  maxConnections: 2,
  applicationName: 'tracksmith-cli',
});

try {
  switch (command) {
    case 'check-upgrade': {
      const checks = await checkUpgrade(db, {
        ...(process.env.TRACKSMITH_DATA ? { dataDir: process.env.TRACKSMITH_DATA } : {}),
      });
      process.stdout.write(formatChecks(checks));
      if (checks.some((c) => c.state === 'block')) process.exitCode = 1;
      break;
    }
    case 'migrate': {
      const applied = await migrateToLatest(db);
      process.stdout.write(
        applied.length === 0 ? 'Up to date.\n' : `Applied: ${applied.join(', ')}\n`,
      );
      break;
    }
    case 'status': {
      process.stdout.write(`${JSON.stringify(await migrationStatus(db), null, 2)}\n`);
      break;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
  }
} finally {
  await db.destroy();
}

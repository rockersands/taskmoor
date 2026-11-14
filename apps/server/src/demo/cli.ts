// pnpm demo [--port 8080] [--fresh] [--tickets [file]]
//
// A Taskmoor to look around in, on this machine, in Spanish (the user's review of the Spanish
// catalogue, M1-116): an embedded PostgreSQL 16 (no Docker), the eval dataset's people, groups,
// tracks, releases, areas and tickets with their history and comments (M1-133), every person's
// language set to Spanish, and the real server (`main.ts`) with every role, serving the built
// frontend on http://localhost:<port>. Each start prints one-time links to set a password for the
// site administrator and for three people; nothing is printed or stored in plain text.
//
// The tickets stay in the database between runs (.cache/pg-test/demo, or your own server), and
// the attachments in .cache/demo. --fresh removes only the attachments: it keeps
// the database. Not for production: no TLS, no backups, no email.
//
// --tickets loads docs/plan/tickets.md (or the file given) once the server is up (T-239): the
// Backend, Front and Flutter tracks with a ticket per row, the sample tracks in the trash. A
// rerun adds only new rows and moves the others to the state the file gives them now.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb, migrateToLatest } from '@taskmoor/db';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';
import { sql } from 'kysely';
import { seedEvalDataset } from '../ai/evals/seed';
import { createPasswordLink, passwordLinkUrl } from '../directory';
import { INSTANCE_KEY, readSetting, SETUP_KEY, writeSetting } from '../setup';
import { buildMessage, frontendBuildNeeded } from './frontend';
import { fetchRequest, loadDemoTickets } from './load-tickets';
import { releaseSampleWorkflow } from './sample-workflow';
import { parseTicketsFile, type TicketRow } from './tickets-file';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DATA = join(ROOT, '.cache', 'demo');
const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', default: '8080' },
    fresh: { type: 'boolean', default: false },
    tickets: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
const port = Number(values.port);
const publicUrl = `http://localhost:${port}`;
const say = (line: string) => process.stdout.write(`${line}\n`);

if (positionals.length > (values.tickets ? 1 : 0)) {
  process.stderr.write('usage: pnpm demo [--port N] [--fresh] [--tickets [file]]\n');
  process.exit(2);
}
// Read before anything starts, so a wrong path stops at once. pnpm runs this from the
// repository; a relative path is the caller's.
let tickets: TicketRow[] | null = null;
if (values.tickets) {
  const file = positionals[0]
    ? resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0])
    : join(ROOT, 'docs', 'plan', 'tickets.md');
  tickets = parseTicketsFile(readFileSync(file, 'utf8'));
  if (tickets.length === 0) {
    process.stderr.write('no ticket rows in that file\n');
    process.exit(2);
  }
}

if (values.fresh) rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// The frontend the server serves: built once, and again when the checkout's frontend sources or
// version moved past the build's (T-211), so a pull never leaves an older app being served.
const webDir = join(ROOT, 'apps', 'web', 'dist');
const build = frontendBuildNeeded(ROOT);
if (build !== null) {
  say(buildMessage(build));
  const built = spawnSync('corepack', ['pnpm', '--filter', '@taskmoor/web', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

say('Starting PostgreSQL...');
// A server of your own when TASKMOOR_TEST_DATABASE_URL names one (as for the tests), else the
// embedded one, kept in .cache/pg-test/demo.
const external = process.env.TASKMOOR_TEST_DATABASE_URL;
const pg = external
  ? { adminUrl: external, stop: async () => {} }
  : await startEmbeddedPostgres({ name: 'demo' });
const admin = createDb({ connectionString: pg.adminUrl, maxConnections: 1 });
const exists = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_database
  WHERE datname = 'taskmoor_demo'`.execute(admin);
if (!exists.rows[0]?.n) await sql`CREATE DATABASE taskmoor_demo`.execute(admin);
await admin.destroy();
const url = new URL(pg.adminUrl);
url.pathname = '/taskmoor_demo';
const db = createDb({ connectionString: url.toString(), maxConnections: 5 });
await migrateToLatest(db);

if (!(await readSetting<{ completed: boolean }>(db, SETUP_KEY))?.completed) {
  say('Adding the sample data (people, tracks, tickets; about a minute)...');
  await seedEvalDataset(db);
  await writeSetting(db, INSTANCE_KEY, { name: 'Taskmoor de prueba' });
  await writeSetting(db, SETUP_KEY, { completed: true, completedAt: new Date().toISOString() });
}
// A database seeded before sample tracks moved freely leaves its strict workflow (WF-008).
await releaseSampleWorkflow(db);
// Everyone reads the app in Spanish; the account page changes it back per person.
await db.updateTable('app_user').set({ locale: 'es' }).where('kind', '=', 'person').execute();

// One-time links to set a password, made the way `cli.mjs password-link` makes them.
const people = await db
  .selectFrom('app_user')
  .select(['id', 'email', 'name', 'is_site_admin'])
  .where('kind', '=', 'person')
  .where('deactivated_at', 'is', null)
  .orderBy('is_site_admin', 'desc')
  .orderBy('id')
  .limit(4)
  .execute();
const links: string[] = [];
for (const p of people) {
  const link = await createPasswordLink(db, {
    workspaceId: 1,
    userId: p.id,
    purpose: 'reset',
    createdBy: null,
  });
  links.push(
    `  ${p.name} <${p.email}>${p.is_site_admin ? ' (site administrator)' : ''}\n    ${passwordLinkUrl(publicUrl, link.token)}`,
  );
}

say('Starting Taskmoor...');
const server = spawn(
  process.execPath,
  ['--import', 'tsx', join(ROOT, 'apps', 'server', 'src', 'main.ts')],
  {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      DATABASE_URL: url.toString(),
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: publicUrl,
      TASKMOOR_ROLE: 'api,worker,realtime,web',
      TASKMOOR_WEB_DIR: webDir,
      TASKMOOR_WEB_ROUTING: 'path',
      TASKMOOR_DATA: join(DATA, 'data'),
      TASKMOOR_BACKUP_DIR: 'off',
      LOG_LEVEL: 'warn',
      METRICS_PORT: '0',
    },
  },
);
const stop = async () => {
  server.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', async (code) => {
  await pg.stop();
  process.exit(code ?? 0);
});

for (let i = 0; i < 120; i++) {
  const ready = await fetch(`${publicUrl}/ready`).then(
    (r) => r.ok,
    () => false,
  );
  if (ready) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (tickets) {
  say(`Loading ${tickets.length} tickets into the Backend, Front and Flutter tracks...`);
  try {
    const done = await loadDemoTickets(db, tickets, fetchRequest(publicUrl));
    say(
      `Tickets: ${done.ticketsCreated} added (${done.moved} moved to their state), ` +
        `${done.updated} brought up to date, ${done.unchanged} unchanged; ` +
        `tracks: ${done.tracksCreated} made, ${done.tracksRestored} back from the trash, ` +
        `${done.tracksTrashed} sample tracks in the trash.`,
    );
    for (const problem of done.problems) say(`  not done: ${problem}`);
  } catch (error) {
    say(`Loading the tickets stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
await db.destroy();
say(`
Taskmoor is running on ${publicUrl} (in Spanish). Open a link below to set a password, then
sign in. Each link works once; a new start makes new ones.

${links.join('\n')}

Ctrl+C stops it; the tickets stay in the database under .cache/pg-test/demo.`);

// The backend for the end-to-end suite: a Postgres with its own database, migrated,
// the API on a fixed port with a fixed setup token, fake OpenID Connect and SAML providers
// for the single sign-on tests, and a fake LDAP directory with the worker's sync loop. Playwright starts it as a web server and the Vite preview proxies /api
// to it. Started with: tsx apps/web/e2e/api-server.ts
//
// Attachments (M1-016) get a database of their own, set up here, served twice: on 8791 with
// files on local disk and on 8792 with files in an S3-compatible bucket (a fake one on 8793,
// checking every request's signature). Two more previews (4174, 4175) proxy to them.
//
// Bulk changes (M1-021) use that database and its administrator too: a job loop here runs
// their jobs, and only theirs, as a worker would. So do notifications (M1-058): the worker's
// event loop runs there, and the inbox test reads what it writes.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrateToLatest } from '@taskmoor/db';
import {
  Authorizer,
  aiKeyRing,
  BULK_TASK,
  buildApp,
  EventBus,
  eventTask,
  FieldCatalogs,
  issueSetupToken,
  JobRunner,
  registerBulkJobs,
  registerSubscribers,
  startDirectorySync,
  startWorker,
  storesOf,
} from '@taskmoor/server';
import { FakeIdp, FakeLdap, FakeProviderServer, FakeSamlIdp } from '@taskmoor/server/testing';
import { LocalStore, S3Store } from '@taskmoor/storage';
import { FakeS3 } from '@taskmoor/storage/testing';
import { createDatabase } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';

export const E2E_API_PORT = 8787;
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789';
export const E2E_IDP_PORT = 8788;
export const E2E_SAML_IDP_PORT = 8789;
export const E2E_LDAP_PORT = 8790;
export const E2E_ATTACH_LOCAL_PORT = 8791;
export const E2E_ATTACH_S3_PORT = 8792;
export const E2E_FAKE_S3_PORT = 8793;
export const E2E_ATTACH_ADMIN = 'ada@attach.test';
export const E2E_AI_PROVIDER_PORT = 8796;

// Always signs in the same synthetic person; the tests register it as a provider first.
const idp = new FakeIdp('taskmoor-e2e', 'e2e-client-secret-0123456789');
await idp.start(E2E_IDP_PORT);
idp.person = { sub: 'e2e-sam', email: 'sam@sso.test', name: 'Sam Rivera' };

// The SAML one (M1-081) signs in Riley; its metadata is at /metadata for the test to paste.
const samlIdp = new FakeSamlIdp();
await samlIdp.start(E2E_SAML_IDP_PORT);
samlIdp.person = {
  nameId: 'e2e-riley',
  nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  attributes: { email: ['riley@saml.test'], displayName: ['Riley Chen'] },
};

// The directory (M1-082): an OpenLDAP-like server with two people in a group inside a group.
// Its passwords are made per run by playwright.config.ts and shared through the environment.
const ldap = new FakeLdap({
  flavour: 'openldap',
  baseDn: 'dc=e2e,dc=test',
  bindPassword: process.env.TASKMOOR_E2E_LDAP_BIND_PASSWORD as string,
});
await ldap.start(E2E_LDAP_PORT);
const morgan = ldap.addUser({
  username: 'morgan',
  mail: 'morgan@ldap.test',
  displayName: 'Morgan Lee',
  password: process.env.TASKMOOR_E2E_LDAP_USER_PASSWORD as string,
});
const noor = ldap.addUser({ username: 'noor', mail: 'noor@ldap.test', displayName: 'Noor Haddad' });
const designers = ldap.addGroup({ cn: 'Designers', members: [morgan, noor] });
ldap.addGroup({ cn: 'Studio', members: [designers] });

// An embedded cluster of its own, unless TASKMOOR_TEST_DATABASE_URL names a server, as for the
// unit tests (CI's service container; containers running as root, where initdb refuses).
const external = process.env.TASKMOOR_TEST_DATABASE_URL;
const server = external
  ? { adminUrl: external, stop: async () => {} }
  : await startEmbeddedPostgres({ name: 'e2e' });
const database = await createDatabase(server.adminUrl);
const db = createDb({ connectionString: database.url, maxConnections: 5 });
await migrateToLatest(db);
await issueSetupToken(db, E2E_SETUP_TOKEN);

// Attachments: their own database with its administrator and a track, then two APIs on it.
const attachDatabase = await createDatabase(server.adminUrl);
const attachDb = createDb({ connectionString: attachDatabase.url, maxConnections: 5 });
await migrateToLatest(attachDb);
const files = mkdtempSync(join(tmpdir(), 'taskmoor-e2e-files-'));
const local = await LocalStore.open(files);
const bucket = new FakeS3(['taskmoor-e2e']);
await bucket.start(E2E_FAKE_S3_PORT);
const s3 = new S3Store({
  bucket: 'taskmoor-e2e',
  region: bucket.region,
  endpoint: bucket.endpoint,
  forcePathStyle: true,
  prefix: '',
  credentials: bucket.credentials,
});
// AI (M1-076): both share one master key, made per run, so a key stored through one opens in
// the other; and a provider on 8796 that answers like the Anthropic API from the recorded
// fixtures and accepts the run's key (ai-settings.spec.ts).
const aiKeys = aiKeyRing({ masterKey: randomBytes(32).toString('base64url') });
const aiProvider = new FakeProviderServer();
aiProvider.accepted.add(process.env.TASKMOOR_E2E_AI_KEY as string);
await aiProvider.start(E2E_AI_PROVIDER_PORT);
// Both also co-edit rich text (the realtime role, M1-017); the rich text tests use the first.
const attachApps = [
  await buildApp({
    db: attachDb,
    version: 'e2e',
    roles: ['api', 'realtime'],
    logLevel: 'warn',
    publicUrl: 'http://localhost:4174',
    // The frontend kits on static hosts that pass /api here (kit-server.ts): their pages'
    // origins, as an install lists a host that proxies to it (M1-107).
    allowedOrigins: ['http://localhost:4178', 'http://localhost:4179'],
    attachments: storesOf(local, { others: [s3] }),
    aiKeys,
  }),
  await buildApp({
    db: attachDb,
    version: 'e2e',
    roles: ['api', 'realtime'],
    logLevel: 'warn',
    publicUrl: 'http://localhost:4175',
    attachments: storesOf(s3, { others: [local] }),
    aiKeys,
  }),
];
{
  const [first] = attachApps;
  const setup = await first?.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: {
      token: await issueSetupToken(attachDb),
      instanceName: 'Attachments',
      admin: {
        name: 'Ada Attach',
        email: E2E_ATTACH_ADMIN,
        password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD as string,
      },
    },
  });
  const cookies = [setup?.headers['set-cookie'] ?? []].flat();
  const cookie =
    cookies
      .find((c) => c.startsWith('taskmoor_session=') && !c.startsWith('taskmoor_session=;'))
      ?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`attachments e2e setup failed: ${setup?.body}`);
  // A fresh install requires a second factor for site administrators (the user's decision of
  // 2026-11-01); these test servers sign in with passwords only, so they turn it off.
  // setup.spec.ts and the fresh-install run (e2e-fresh) cover the default.
  await attachDb.updateTable('two_factor_policy').set({ required: 'none' }).execute();
  const track = await first?.inject({
    method: 'POST',
    url: '/api/v1/tracks',
    headers: { cookie },
    payload: { key: 'ATT', name: 'Attachments', mode: 'shared' },
  });
  if (track?.statusCode !== 201) throw new Error(`attachments e2e setup failed: ${track?.body}`);
}
await attachApps[0]?.listen({ port: E2E_ATTACH_LOCAL_PORT, host: '127.0.0.1' });
await attachApps[1]?.listen({ port: E2E_ATTACH_S3_PORT, host: '127.0.0.1' });

// Bulk changes on the attachments database: the worker's loop, for their task alone.
const bulkRunner = new JobRunner(attachDb, 'e2e-bulk', { tasks: [BULK_TASK] });
// Clones (M1-124) run there too, copying attachments between both stores.
registerBulkJobs(bulkRunner, attachDb, new Authorizer(attachDb), new FieldCatalogs(attachDb), {
  stores: storesOf(local, { others: [s3] }),
});
let bulkRunning = true;
const bulkLoop = (async () => {
  while (bulkRunning) {
    const ran = await bulkRunner.runOnce().catch(() => 0);
    if (ran === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
})();

// Notifications on the attachments database (M1-058): the worker's event loop, with its
// production idle wait, so mentions reach the inbox as they would in an install.
const eventBus = new EventBus(attachDb);
registerSubscribers(eventBus, { db: attachDb });
const eventRunner = new JobRunner(attachDb, 'e2e-events', {
  tasks: [eventTask('audit'), eventTask('notifications')],
});
eventBus.attach(eventRunner);
const eventWorker = startWorker({ bus: eventBus, runner: eventRunner, db: attachDb });

const app = await buildApp({
  db,
  version: 'e2e',
  // The realtime role: the sync engine's socket (M1-032) and co-editing (M1-017).
  roles: ['api', 'realtime'],
  logLevel: 'warn',
  publicUrl: 'http://localhost:4173',
});
await app.listen({ port: E2E_API_PORT, host: '127.0.0.1' });
// The worker's directory loop, so a sync asked for on the page runs.
const directories = startDirectorySync(db, { worker: 'e2e', pollMs: 500 });
process.stdout.write(`e2e API listening on http://127.0.0.1:${E2E_API_PORT}\n`);

async function stop(): Promise<void> {
  await directories.stop();
  bulkRunning = false;
  await bulkLoop;
  await eventWorker.stop();
  await app.close();
  for (const attachApp of attachApps) await attachApp.close();
  await aiProvider.stop();
  s3.destroy();
  await bucket.stop();
  rmSync(files, { recursive: true, force: true });
  await attachDb.destroy();
  await attachDatabase.drop();
  await ldap.stop();
  await idp.stop();
  await samlIdp.stop();
  await db.destroy();
  await database.drop();
  await server.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

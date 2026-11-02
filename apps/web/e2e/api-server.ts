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
// their jobs, and only theirs, as a worker would (and a person's data downloads, ADR-111). So do notifications (M1-058): the worker's
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
  EMBEDDING_SUBSCRIBER,
  EmbeddingService,
  ERASE_SCRUB_TASK,
  EventBus,
  embeddingSubscriber,
  eventTask,
  FieldCatalogs,
  issueSetupToken,
  JobRunner,
  PERSONAL_EXPORT_TASK,
  registerBulkJobs,
  registerEmbeddingJobs,
  registerEraseJobs,
  registerPersonalExportJobs,
  registerSubscribers,
  SWEEP_TASK,
  sharedLocalEmbedder,
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
/** The AI features backends (M1-079): AI set up on the fake provider, and no provider at all. */
export const E2E_AI_API_PORT = 8797;
export const E2E_AI_ADMIN = 'ada@ai.test';
export const E2E_NO_AI_API_PORT = 8798;
export const E2E_NO_AI_ADMIN = 'ada@no-ai.test';

// The fake identity and AI providers listen on loopback, which the outbound guard refuses
// unless the operator allows it (ASVS 5.2.6; ADR-110): allowed here as an operator would.
process.env.TASKMOOR_OUTBOUND_ALLOW = '127.0.0.1,::1';

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
// A scripted model for the AI features (M1-079, ai-features-fake.spec.ts): it answers each
// feature by the instructions it was sent, in the shape the feature asks for.
aiProvider.answer = ({ system, prompt }) => {
  if (system.startsWith('You summarise')) {
    const comment = /<comment id="c(\d+)"/.exec(prompt)?.[1];
    const key = /ticket (\S+)\./.exec(prompt)?.[1] ?? 'the ticket';
    return `${key} is about a blank checkout page with an expired card${comment ? ` [c${comment}]` : ''}. The next step is a fix in the payment form, then a test for every card state.`;
  }
  if (system.includes('query language')) {
    return JSON.stringify({
      query: 'assignee = currentUser() AND stage != closed',
      explanation: 'Open tickets assigned to you.',
    });
  }
  if (system.startsWith('You help a person break')) {
    return JSON.stringify({
      children: [
        { summary: 'Store cards securely', description: 'Use the payment vault.', type: 'Feature' },
        { summary: 'Pick a saved card at checkout', description: 'A list.', type: 'Feature' },
        { summary: 'Remove a saved card', description: 'From the account page.', type: 'Feature' },
      ],
    });
  }
  if (system.startsWith('You help a person turn')) {
    return JSON.stringify({
      drafts: [
        {
          summary: 'Refund button does nothing on Safari',
          description: 'Clicking Refund on Safari does nothing.',
          type: 'Bug',
          priority: 'High',
          labels: [],
        },
      ],
    });
  }
  if (system.startsWith('A person is writing')) {
    const keys = [...prompt.matchAll(/<ticket key="([^"]+)">/g)].map((m) => m[1]);
    return JSON.stringify({
      ranked: keys.map((key) => ({ key, likely: true, reason: 'The same blank checkout page.' })),
    });
  }
  return undefined;
};
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
const bulkRunner = new JobRunner(attachDb, 'e2e-bulk', {
  tasks: [BULK_TASK, PERSONAL_EXPORT_TASK, ERASE_SCRUB_TASK],
});
// Clones (M1-124) run there too, copying attachments between both stores.
registerBulkJobs(bulkRunner, attachDb, new Authorizer(attachDb), new FieldCatalogs(attachDb), {
  stores: storesOf(local, { others: [s3] }),
});
// A person's data (ASVS 8.3.2): downloads into the local store, and the erasure's scrub.
registerPersonalExportJobs(
  bulkRunner,
  attachDb,
  storesOf(local, { others: [s3] }),
  new Authorizer(attachDb),
);
registerEraseJobs(bulkRunner, attachDb);
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

// The AI features (M1-079) get two backends of their own, so ai-settings.spec.ts, which switches
// AI on and off on 8791, touches neither: one with AI set up on the fake provider through the
// admin API (8797, preview 4186), one with no provider at all (8798, preview 4187) whose
// embeddings are indexed as a worker would, for duplicate suggestions without a key.
async function aiFeaturesBackend(options: {
  port: number;
  preview: number;
  email: string;
  withProvider: boolean;
}) {
  const database = await createDatabase(server.adminUrl);
  const backendDb = createDb({ connectionString: database.url, maxConnections: 5 });
  await migrateToLatest(backendDb);
  const backend = await buildApp({
    db: backendDb,
    version: 'e2e',
    roles: ['api'],
    logLevel: 'warn',
    publicUrl: `http://localhost:${options.preview}`,
    aiKeys,
  });
  const setup = await backend.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: {
      token: await issueSetupToken(backendDb),
      instanceName: 'AI features',
      admin: {
        name: 'Ada Ai',
        email: options.email,
        password: process.env.TASKMOOR_E2E_AI_PASSWORD as string,
      },
    },
  });
  const cookie =
    [setup.headers['set-cookie'] ?? []]
      .flat()
      .find((c) => c.startsWith('taskmoor_session=') && !c.startsWith('taskmoor_session=;'))
      ?.split(';')[0] ?? '';
  if (!cookie) throw new Error(`AI e2e setup failed: ${setup.body}`);
  await backendDb.updateTable('two_factor_policy').set({ required: 'none' }).execute();
  const steps = [
    {
      method: 'POST' as const,
      url: '/api/v1/tracks',
      payload: { key: 'AIF', name: 'AI features', mode: 'shared' },
    },
    ...(options.withProvider
      ? [
          {
            method: 'PUT' as const,
            url: '/api/v1/admin/ai/credentials/apiKey',
            payload: { value: process.env.TASKMOOR_E2E_AI_KEY as string },
          },
          {
            method: 'PUT' as const,
            url: '/api/v1/admin/ai',
            payload: {
              enabled: true,
              strict: false,
              provider: {
                provider: 'anthropic',
                baseUrl: `http://127.0.0.1:${E2E_AI_PROVIDER_PORT}`,
              },
              features: {},
            },
          },
        ]
      : []),
  ];
  for (const step of steps) {
    const res = await backend.inject({ ...step, headers: { cookie } });
    if (res.statusCode >= 300) throw new Error(`AI e2e setup: ${step.url}: ${res.body}`);
  }
  // The worker's embedding jobs, and nothing else, so what a test writes is found.
  const embeddings = new EmbeddingService(backendDb, sharedLocalEmbedder());
  await embeddings.prepare();
  const bus = new EventBus(backendDb);
  bus.subscribe(embeddingSubscriber(backendDb, embeddings.indexer));
  const runner = new JobRunner(backendDb, `e2e-embeddings-${options.port}`, {
    tasks: [eventTask(EMBEDDING_SUBSCRIBER), SWEEP_TASK],
  });
  bus.attach(runner);
  registerEmbeddingJobs(runner, backendDb, embeddings.indexer);
  const worker = startWorker({ bus, runner, db: backendDb });
  await backend.listen({ port: options.port, host: '127.0.0.1' });
  return {
    stop: async () => {
      await worker.stop();
      await backend.close();
      await backendDb.destroy();
      await database.drop();
    },
  };
}
const aiBackends = [
  await aiFeaturesBackend({
    port: E2E_AI_API_PORT,
    preview: 4186,
    email: E2E_AI_ADMIN,
    withProvider: true,
  }),
  await aiFeaturesBackend({
    port: E2E_NO_AI_API_PORT,
    preview: 4187,
    email: E2E_NO_AI_ADMIN,
    withProvider: false,
  }),
];

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
  for (const backend of aiBackends) await backend.stop();
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

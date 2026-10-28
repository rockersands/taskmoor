// The backend for the end-to-end suite: a Postgres with its own database, migrated,
// the API on a fixed port with a fixed setup token, fake OpenID Connect and SAML providers
// for the single sign-on tests, and a fake LDAP directory with the worker's sync loop. Playwright starts it as a web server and the Vite preview proxies /api
// to it. Started with: tsx apps/web/e2e/api-server.ts
import { createDb, migrateToLatest } from '@taskmoor/db';
import { buildApp, issueSetupToken, startDirectorySync } from '@taskmoor/server';
import { FakeIdp, FakeLdap, FakeSamlIdp } from '@taskmoor/server/testing';
import { createDatabase } from '@taskmoor/testkit/pg';
import { startEmbeddedPostgres } from '@taskmoor/testkit/server';

export const E2E_API_PORT = 8787;
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789';
export const E2E_IDP_PORT = 8788;
export const E2E_SAML_IDP_PORT = 8789;
export const E2E_LDAP_PORT = 8790;

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

const app = await buildApp({
  db,
  version: 'e2e',
  roles: ['api'],
  logLevel: 'warn',
  publicUrl: 'http://localhost:4173',
});
await app.listen({ port: E2E_API_PORT, host: '127.0.0.1' });
// The worker's directory loop, so a sync asked for on the page runs.
const directories = startDirectorySync(db, { worker: 'e2e', pollMs: 500 });
process.stdout.write(`e2e API listening on http://127.0.0.1:${E2E_API_PORT}\n`);

async function stop(): Promise<void> {
  await directories.stop();
  await app.close();
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

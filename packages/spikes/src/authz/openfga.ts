import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Agent } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenFgaClient, type TupleKey } from '@openfga/sdk';
import { transformer } from '@openfga/syntax-transformer';
import axios from 'axios';
import { type AuthzModel, PERMISSIONS, ROLES } from './model';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The SDK's own HTTP client gives up after 10 s; bulk writes on a busy disk take longer. */
function fgaClient(config: ConstructorParameters<typeof OpenFgaClient>[0]): OpenFgaClient {
  return new OpenFgaClient(
    config,
    axios.create({ httpAgent: new Agent({ keepAlive: true }), timeout: 120_000 }),
  );
}

/** The OpenFGA server binary the spike runs as a co-process; absent on CI, present on the dev box. */
export const OPENFGA_BINARY =
  process.env.OPENFGA_BINARY ??
  join(
    REPO_ROOT,
    '.cache',
    'tools',
    'openfga',
    process.platform === 'win32' ? 'openfga.exe' : 'openfga',
  );

export function openFgaAvailable(): boolean {
  return existsSync(OPENFGA_BINARY);
}

/**
 * The same model as the SQL tables, in OpenFGA's language. A policy carries one flag relation
 * per (permission, role) pair, held by `user:*` when the policy grants that permission to the
 * role, plus a direct relation for user, group, lead and wildcard grants; a space links to its
 * policy, names its role actors, and derives each permission by intersecting role membership
 * with the policy's flag.
 */
export function openFgaModelDsl(): string {
  const lines = ['model', '  schema 1.1', '', 'type user', '', 'type group', '  relations'];
  lines.push('    define member: [user, group#member]', '', 'type policy', '  relations');
  for (const p of PERMISSIONS) {
    lines.push(`    define ${rel(p)}_direct: [user, group#member, user:*]`);
    lines.push(`    define ${rel(p)}_lead: [user:*]`);
    for (const role of ROLES) lines.push(`    define ${rel(p)}_${role}: [user:*]`);
  }
  lines.push(
    '',
    'type space',
    '  relations',
    '    define policy: [policy]',
    '    define lead: [user]',
  );
  for (const role of ROLES) lines.push(`    define ${role}: [user, group#member]`);
  for (const p of PERMISSIONS) {
    const parts = [
      `${rel(p)}_direct from policy`,
      `(lead and ${rel(p)}_lead from policy)`,
      ...ROLES.map((role) => `(${role} and ${rel(p)}_${role} from policy)`),
    ];
    lines.push(`    define ${rel(p)}: ${parts.join(' or ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** OpenFGA relation names allow letters, digits and underscores. */
export function rel(permission: string): string {
  return permission.replace(/-/g, '_');
}

const ROLE_NAME_BY_ID = new Map<number, string>(ROLES.map((r, i) => [i + 1, r]));

/** The model's facts as OpenFGA tuples. */
export function openFgaTuples(model: AuthzModel): TupleKey[] {
  const tuples: TupleKey[] = [];
  for (const [u, g] of model.memberships) {
    tuples.push({ user: `user:${u}`, relation: 'member', object: `group:${g}` });
  }
  for (const s of model.spaces) {
    tuples.push({ user: `policy:${s.policyId}`, relation: 'policy', object: `space:${s.id}` });
    tuples.push({ user: `user:${s.leadId}`, relation: 'lead', object: `space:${s.id}` });
  }
  for (const a of model.roleActors) {
    const role = ROLE_NAME_BY_ID.get(a.roleId);
    if (!role) throw new Error(`Unknown role ${a.roleId}`);
    tuples.push({
      user: a.kind === 'user' ? `user:${a.id}` : `group:${a.id}#member`,
      relation: role,
      object: `space:${a.spaceId}`,
    });
  }
  for (const g of model.grants) {
    const object = `policy:${g.policyId}`;
    const p = rel(g.permission);
    switch (g.kind) {
      case 'anyone':
      case 'authenticated':
        tuples.push({ user: 'user:*', relation: `${p}_direct`, object });
        break;
      case 'user':
        tuples.push({ user: `user:${g.id}`, relation: `${p}_direct`, object });
        break;
      case 'group':
        tuples.push({ user: `group:${g.id}#member`, relation: `${p}_direct`, object });
        break;
      case 'lead':
        tuples.push({ user: 'user:*', relation: `${p}_lead`, object });
        break;
      case 'role': {
        const role = ROLE_NAME_BY_ID.get(g.id);
        if (!role) throw new Error(`Unknown role ${g.id}`);
        tuples.push({ user: 'user:*', relation: `${p}_${role}`, object });
        break;
      }
    }
  }
  // The same (user, relation, object) can come from two grants; OpenFGA rejects duplicates.
  const seen = new Set<string>();
  return tuples.filter((t) => {
    const key = `${t.user}|${t.relation}|${t.object}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface OpenFgaServer {
  url: string;
  stop(): Promise<void>;
}

/** Migrates the datastore and starts `openfga run` on free loopback ports. */
export async function startOpenFga(datastoreUri: string): Promise<OpenFgaServer> {
  if (!openFgaAvailable()) throw new Error(`No OpenFGA binary at ${OPENFGA_BINARY}`);
  const datastore = ['--datastore-engine', 'postgres', '--datastore-uri', datastoreUri];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(OPENFGA_BINARY, ['migrate', ...datastore], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`openfga migrate exited ${code}: ${err}`)),
    );
  });
  const httpPort = await freePort();
  const grpcPort = await freePort();
  const child = spawn(
    OPENFGA_BINARY,
    [
      'run',
      ...datastore,
      '--http-addr',
      `127.0.0.1:${httpPort}`,
      '--grpc-addr',
      `127.0.0.1:${grpcPort}`,
      '--log-level',
      'error',
      '--playground-enabled=false',
      '--max-tuples-per-write',
      '100',
      '--listObjects-max-results',
      '100000',
      '--listObjects-deadline',
      '120s',
      '--request-timeout',
      '120s',
      '--check-query-cache-enabled=false',
      // Metrics default to a fixed port, which a second instance cannot bind.
      '--metrics-enabled=false',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  // OpenFGA logs to stdout; keep the tail of both streams for error messages.
  const keep = (d: Buffer) => {
    stderr = (stderr + d).slice(-4000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const url = `http://127.0.0.1:${httpPort}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`openfga run exited: ${stderr}`);
    const ok = await fetch(`${url}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`OpenFGA did not become healthy: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** Creates a store with the model and writes every tuple; returns a client bound to both. */
export async function prepareOpenFga(
  url: string,
  model: AuthzModel,
  log: (m: string) => void = () => {},
): Promise<{ client: OpenFgaClient; tuples: number; writeSeconds: number }> {
  const base = fgaClient({ apiUrl: url });
  const store = await base.createStore({ name: 'tracksmith-spike' });
  const client = fgaClient({ apiUrl: url, storeId: store.id });
  const authorizationModel = transformer.transformDSLToJSONObject(openFgaModelDsl());
  const written = await client.writeAuthorizationModel({
    schema_version: authorizationModel.schema_version,
    type_definitions: authorizationModel.type_definitions,
    conditions: authorizationModel.conditions ?? {},
  });
  const bound = fgaClient({
    apiUrl: url,
    storeId: store.id,
    authorizationModelId: written.authorization_model_id,
  });
  const tuples = openFgaTuples(model);
  const t0 = Date.now();
  const batch = 100;
  const parallel = 4;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const start = next;
      next += batch;
      if (start >= tuples.length) return;
      await bound.write(
        { writes: tuples.slice(start, start + batch) },
        { transaction: { disable: false } },
      );
      if (start % (batch * 100) === 0) log(`  tuples: ${start.toLocaleString('en')}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return { client: bound, tuples: tuples.length, writeSeconds: (Date.now() - t0) / 1000 };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not pick a free port.'));
      });
    });
  });
}

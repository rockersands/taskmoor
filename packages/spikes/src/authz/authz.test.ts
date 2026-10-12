import { Rng } from '@tracksmith/testkit/gen';
import { useTestDatabase } from '@tracksmith/testkit/pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedSpaces, loadAuthz, PermissionCache, permissionsFor } from './evaluator';
import { createAuthzModel, PERMISSIONS, ReferenceEvaluator, scaleAuthz } from './model';
import {
  openFgaAvailable,
  openFgaModelDsl,
  openFgaTuples,
  prepareOpenFga,
  startOpenFga,
} from './openfga';

const config = scaleAuthz(400, 60, 3);
const model = createAuthzModel(config);
const reference = new ReferenceEvaluator(model);

function triples(count: number, seed: number) {
  const rng = new Rng(seed);
  return Array.from({ length: count }, () => ({
    user: rng.int(1, config.users),
    space: rng.int(1, config.spaces),
    permission: rng.pick(PERMISSIONS),
  }));
}

describe('authz model', () => {
  it('is deterministic and has every grantee kind', () => {
    const again = createAuthzModel(config);
    expect(again.grants.length).toBe(model.grants.length);
    expect(again.roleActors[10]).toEqual(model.roleActors[10]);
    const kinds = new Set(model.grants.map((g) => g.kind));
    for (const k of ['anyone', 'authenticated', 'lead', 'user', 'group', 'role']) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });

  it('[IAM-010] lets the space lead administer when the policy grants the lead', () => {
    const space = model.spaces.find((s) =>
      model.grants.some(
        (g) => g.policyId === s.policyId && g.permission === 'administer' && g.kind === 'lead',
      ),
    );
    expect(space).toBeDefined();
    if (space) expect(reference.check(space.leadId, space.id, 'administer')).toBe(true);
  });
});

describe('in-process evaluator', () => {
  const database = useTestDatabase();
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: database.url, max: 3 });
    await loadAuthz(pool, model);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('[IAM-012] agrees with the reference reading on random checks', async () => {
    const client = await pool.connect();
    try {
      for (const t of triples(300, 5)) {
        const set = await permissionsFor(client, t.user, t.space);
        expect(set.has(t.permission), `${t.user} ${t.permission} in ${t.space}`).toBe(
          reference.check(t.user, t.space, t.permission),
        );
      }
    } finally {
      client.release();
    }
  });

  it('[QRY-008] lists the spaces a user may browse', async () => {
    const client = await pool.connect();
    try {
      for (const user of [1, 2, 17, 250, 399]) {
        expect(await allowedSpaces(client, user, 'browse')).toEqual(
          reference.allowedSpaces(user, 'browse'),
        );
      }
    } finally {
      client.release();
    }
  });

  it('caches per (user, space) and evicts the least recently used entry', async () => {
    const client = await pool.connect();
    try {
      const cache = new PermissionCache(client, 2);
      expect(await cache.check(1, 1, 'browse')).toBe(reference.check(1, 1, 'browse'));
      await cache.check(1, 1, 'edit');
      expect(cache.hits).toBe(1);
      await cache.check(1, 2, 'browse');
      await cache.check(1, 3, 'browse'); // evicts (1, 1)
      await cache.check(1, 1, 'browse');
      expect(cache.misses).toBe(4);
      cache.invalidate(1, 3);
      await cache.check(1, 3, 'browse');
      expect(cache.misses).toBe(5);
    } finally {
      client.release();
    }
  });
});

describe('OpenFGA co-process', () => {
  it('renders a model with one relation per permission on spaces', () => {
    const dsl = openFgaModelDsl();
    expect(dsl).toContain('define browse: browse_direct from policy');
    expect(dsl).toContain('define comment_delete_own:');
    expect(openFgaTuples(model).length).toBeGreaterThan(model.memberships.length);
  });

  const database = useTestDatabase();
  it.skipIf(!openFgaAvailable())(
    '[IAM-012] agrees with the reference reading on random checks',
    async () => {
      const server = await startOpenFga(database.url);
      try {
        const { client } = await prepareOpenFga(server.url, model);
        for (const t of triples(60, 9)) {
          const { allowed } = await client.check({
            user: `user:${t.user}`,
            relation: t.permission.replace(/-/g, '_'),
            object: `space:${t.space}`,
          });
          expect(Boolean(allowed), `${t.user} ${t.permission} in ${t.space}`).toBe(
            reference.check(t.user, t.space, t.permission),
          );
        }
        const { objects } = await client.listObjects({
          user: 'user:17',
          relation: 'browse',
          type: 'space',
        });
        expect(objects.map((o) => Number(o.slice(6))).sort((a, b) => a - b)).toEqual(
          reference.allowedSpaces(17, 'browse'),
        );
      } finally {
        await server.stop();
      }
    },
    180_000,
  );
});

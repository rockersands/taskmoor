import { describe, expect, it } from 'vitest';
import { knownMigrations } from './migrate';
import { RELEASES, type Release, upgradePath } from './releases';

const all = knownMigrations();
const latest = all[all.length - 1] as string;

// Earlier releases modelled as points in today's migration list (as the upgrade tests do).
const history: Release[] = [
  { version: '1.0.0', lastMigration: '0012_scim' },
  { version: '1.1.0', lastMigration: '0015_ticket_history' },
  { version: '1.1.1', lastMigration: '0015_ticket_history' },
  { version: '1.2.0', lastMigration: '0020_saml' },
  { version: '1.3.0', lastMigration: '0023_time_tracking' },
];

describe('published releases', () => {
  it('[OPS-007] name known migrations in order, with ascending versions', () => {
    let previous: Release | undefined;
    for (const release of RELEASES) {
      expect(all, release.version).toContain(release.lastMigration);
      if (previous) {
        expect(release.lastMigration >= previous.lastMigration, release.version).toBe(true);
        expect(
          release.version.localeCompare(previous.version, 'en', { numeric: true }),
          release.version,
        ).toBe(1);
      }
      previous = release;
    }
  });
});

describe('upgrade path (ADR-022: N-3 to N)', () => {
  it('[OPS-006] accepts the last three releases, counting distinct schemas, and refuses older', () => {
    expect(upgradePath('0015_ticket_history', latest, history)).toEqual({
      supported: true,
      from: history[2],
      floor: history[1],
    });
    expect(upgradePath('0023_time_tracking', latest, history)).toMatchObject({
      supported: true,
      from: { version: '1.3.0' },
    });
    // A preview build between 1.1 and 1.2 is judged by its last migration.
    expect(upgradePath('0018_ticket_fields', latest, history)).toMatchObject({
      supported: true,
      from: { version: '1.1.1' },
    });
    expect(upgradePath('0012_scim', latest, history)).toMatchObject({
      supported: false,
      from: { version: '1.0.0' },
      floor: { version: '1.1.0' },
    });
    expect(upgradePath('0008_tracks', latest, history)).toMatchObject({
      supported: false,
      from: null,
    });
  });

  it('[OPS-006] [OPS-007] keeps upgrades from the latest long-term-support release supported', () => {
    const withLts = history.map((r) => (r.version === '1.0.0' ? { ...r, lts: true } : r));
    expect(upgradePath('0012_scim', latest, withLts)).toMatchObject({
      supported: true,
      floor: { version: '1.0.0' },
    });
    expect(upgradePath('0010_identity_providers', latest, withLts).supported).toBe(false);
  });

  it('[OPS-006] supports every start before three releases exist, and always a fresh install', () => {
    expect(upgradePath('0001_foundation', latest, history.slice(0, 2))).toEqual({
      supported: true,
      from: null,
      floor: null,
    });
    expect(upgradePath(null, latest, history)).toMatchObject({ supported: true, from: null });
    // A release with this build's own schema is the build itself, not an earlier release.
    const self = [...history, { version: '1.4.0', lastMigration: latest }];
    expect(upgradePath('0015_ticket_history', latest, self).supported).toBe(true);
    expect(upgradePath(latest, latest, self).from).toEqual({
      version: '1.4.0',
      lastMigration: latest,
    });
  });
});

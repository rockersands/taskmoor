/**
 * Published releases and the upgrade path rule (OPS-006, OPS-007, ADR-022).
 *
 * A release is a point in the migration list: the last migration it ships. The upgrade
 * command and the pre-upgrade check refuse a database older than the oldest supported start,
 * because only those starts are tested (the upgrade harness) and because an expand step of one
 * release may need to have run before the contract step of a later one:
 *
 * - **The last three releases** before this build (ADR-022: N-3 to N in one step), counted by
 *   distinct schema points, so patch releases without migrations do not use up the window.
 * - **The latest long-term-support release** (OPS-007) as well, when it is older than that.
 *
 * With fewer than three earlier releases every start is supported. A fresh, empty database is
 * an install, never refused. Databases in between releases (preview builds) are judged by
 * their last migration.
 */
export interface Release {
  /** The release's version, such as 1.4.0. */
  version: string;
  /** The last migration the release ships. */
  lastMigration: string;
  /** A long-term-support release (OPS-007): upgrades from it stay supported. */
  lts?: boolean;
}

/**
 * Every published release, oldest first; previews are not listed. Cutting a release appends
 * one entry (`releases.test.ts` checks the list against the migrations). There are none yet.
 */
export const RELEASES: readonly Release[] = [];

/** How many earlier releases an upgrade may start from (ADR-022). */
export const SUPPORTED_RELEASES_BACK = 3;

export interface UpgradePath {
  supported: boolean;
  /** The newest release whose migrations the database has: where it stands, when known. */
  from: Release | null;
  /** The oldest release this build upgrades from in one step; null when every start is. */
  floor: Release | null;
}

/**
 * Whether a database whose last applied migration is `lastApplied` (null: an empty database)
 * may upgrade in one step to a build whose last migration is `latest`.
 */
export function upgradePath(
  lastApplied: string | null,
  latest: string,
  releases: readonly Release[] = RELEASES,
): UpgradePath {
  const from =
    lastApplied === null
      ? null
      : ([...releases].reverse().find((r) => r.lastMigration <= lastApplied) ?? null);
  // Releases before this build; one whose schema equals the build's is the build itself.
  const earlier = releases.filter((r) => r.lastMigration < latest);
  const points = [...new Set(earlier.map((r) => r.lastMigration))].sort();
  let floor: string | null =
    points.length >= SUPPORTED_RELEASES_BACK
      ? (points[points.length - SUPPORTED_RELEASES_BACK] as string)
      : null;
  const lts = [...earlier].reverse().find((r) => r.lts);
  if (floor !== null && lts && lts.lastMigration < floor) floor = lts.lastMigration;
  return {
    supported: lastApplied === null || floor === null || lastApplied >= floor,
    from,
    floor: floor === null ? null : (earlier.find((r) => r.lastMigration === floor) ?? null),
  };
}

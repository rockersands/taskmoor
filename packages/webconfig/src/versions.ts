/**
 * Which frontends a backend works with (M1-106; API-018, OPS-017, NFR-010; ADR-070). Releases
 * are minor versions. A backend of release x.y serves its own API and the previous release's,
 * so a frontend of x.(y-1) keeps working and is told an update is available, and anything older
 * is told it must update. A development build (a prerelease such as 0.0.0-dev, a `git describe`
 * between tags, or a version that is not x.y.z) names no window and takes any frontend. A major
 * release breaks the API on purpose, so x.0 takes only x.0 frontends.
 */
export interface Release {
  major: number;
  minor: number;
  patch: number;
  /** After the dash: `rc.1`, `dev`; empty for a release. */
  prerelease: string;
}

const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version as x.y.z with its prerelease, or null when it is not one (a commit id, say). */
export function parseRelease(version: string): Release | null {
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? '' };
}

/** Negative, zero or positive as `a` is older than, the same as, or newer than `b`. */
export function compareReleases(a: Release, b: Release): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    // A prerelease comes before its release; two prereleases by their dotted parts.
    (a.prerelease === b.prerelease
      ? 0
      : a.prerelease === ''
        ? 1
        : b.prerelease === ''
          ? -1
          : a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true }))
  );
}

/** The frontends a backend wants: the oldest it still serves, and the one it was built with. */
export interface FrontendWindow {
  minimum: string | null;
  recommended: string | null;
}

export function frontendWindow(backendVersion: string): FrontendWindow {
  const r = parseRelease(backendVersion);
  if (r?.prerelease !== '') return { minimum: null, recommended: null };
  return {
    minimum: r.minor > 0 ? `${r.major}.${r.minor - 1}.0` : `${r.major}.0.0`,
    recommended: `${r.major}.${r.minor}.0`,
  };
}

/** How a frontend stands against a backend's window. */
export type Skew = 'current' | 'update-available' | 'update-required' | 'unknown';

export function frontendSkew(frontendVersion: string, window: FrontendWindow): Skew {
  const frontend = parseRelease(frontendVersion);
  const minimum = window.minimum === null ? null : parseRelease(window.minimum);
  const recommended = window.recommended === null ? null : parseRelease(window.recommended);
  if (!frontend || (!minimum && !recommended)) return 'unknown';
  if (minimum && compareReleases(frontend, minimum) < 0) return 'update-required';
  if (recommended && compareReleases(frontend, recommended) < 0) return 'update-available';
  return 'current';
}

/**
 * The frontend artefact's manifest (M1-105, ADR-066): `version.json` next to index.html names
 * the artefact, its version, which is the backend's version it was built with, and every file
 * with its size and SHA-256. index.html is listed as built, before its slot is filled.
 */

export const ARTEFACT_NAME = 'taskmoor-web';
export const MANIFEST_FILE = 'version.json';
/** The version of a build made without TASKMOOR_VERSION, on both sides. */
export const DEV_VERSION = '0.0.0-dev';
/** What `git describe` and release tags produce: v1.2.3, 1.2.3-rc.1, v1.2.3-4-gabc1234, a SHA. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export interface ArtefactFile {
  /** Relative to the artefact's root, with forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArtefactManifest {
  name: typeof ARTEFACT_NAME;
  version: string;
  files: ArtefactFile[];
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}

/** The version a build stamps: TASKMOOR_VERSION, or the development version. */
export function buildVersion(env: Record<string, string | undefined>): string {
  const version = env.TASKMOOR_VERSION?.trim() || DEV_VERSION;
  if (!isVersion(version)) throw new Error(`TASKMOOR_VERSION is not a version: ${version}`);
  return version;
}

/** Reads a manifest; throws when it is not one. */
export function parseManifest(raw: unknown): ArtefactManifest {
  const value = raw as Partial<ArtefactManifest> | null;
  if (value === null || typeof value !== 'object' || value.name !== ARTEFACT_NAME) {
    throw new Error(`not a ${ARTEFACT_NAME} manifest`);
  }
  if (!isVersion(value.version)) throw new Error('the manifest has no valid version');
  const files = Array.isArray(value.files) ? value.files : null;
  const valid = files?.every(
    (f) =>
      typeof f?.path === 'string' &&
      f.path !== '' &&
      !f.path.startsWith('/') &&
      !f.path.split('/').includes('..') &&
      Number.isInteger(f.bytes) &&
      typeof f.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(f.sha256),
  );
  if (!files || !valid) throw new Error('the manifest lists invalid files');
  return { name: ARTEFACT_NAME, version: value.version, files };
}

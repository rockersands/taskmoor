import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Licences a dependency may use (ADR-029). All are compatible with distributing Tracksmith
 * under AGPL-3.0. Anything else, including a missing licence, fails `pnpm verify`.
 */
export const ALLOWED_LICENCES = new Set([
  '0BSD',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'PostgreSQL',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

export interface PackageLicence {
  name: string;
  version: string;
  licence: string;
}

/**
 * Evaluates an SPDX expression against the allowlist: OR needs one allowed side, AND needs
 * both, WITH exceptions are judged by the base licence.
 */
export function isAllowed(
  expression: string,
  allowed: ReadonlySet<string> = ALLOWED_LICENCES,
): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const primary = (): boolean => {
    const token = next();
    if (token === undefined) throw new Error(`Incomplete licence expression "${expression}"`);
    if (token === '(') {
      const value = orExpr();
      if (next() !== ')') throw new Error(`Unbalanced licence expression "${expression}"`);
      return value;
    }
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      next(); // exceptions only grant extra permissions, so the base licence decides
    }
    return allowed.has(token.replace(/\+$/, ''));
  };
  const andExpr = (): boolean => {
    let value = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      const right = primary();
      value = value && right;
    }
    return value;
  };
  const orExpr = (): boolean => {
    let value = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      const right = andExpr();
      value = value || right;
    }
    return value;
  };

  try {
    const result = orExpr();
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}

function licenceOf(manifest: Record<string, unknown>): string {
  const field = manifest.license ?? manifest.licenses;
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    return field
      .map((l) => (typeof l === 'object' && l && 'type' in l ? String(l.type) : String(l)))
      .join(' OR ');
  }
  if (field && typeof field === 'object' && 'type' in field) return String(field.type);
  return '';
}

/** Lists every installed third-party package from pnpm's store layout (node_modules/.pnpm). */
export function installedPackages(root: string): PackageLicence[] {
  const store = join(root, 'node_modules', '.pnpm');
  const out: PackageLicence[] = [];
  for (const entry of readdirSync(store)) {
    const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
    if (at <= 0) continue;
    const name = entry.slice(0, at).replace('+', '/');
    const manifestPath = join(store, entry, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    out.push({
      name: String(manifest.name ?? name),
      version: String(manifest.version ?? ''),
      licence: licenceOf(manifest),
    });
  }
  return out;
}

export function deniedLicences(packages: readonly PackageLicence[]): string[] {
  return packages
    .filter((p) => !isAllowed(p.licence))
    .map((p) => `${p.name}@${p.version}: ${p.licence || 'no licence declared'}`)
    .sort();
}

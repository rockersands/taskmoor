import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messagesEn } from '../../i18n/messages.en';
import { IMPORT_KINDS, kindLabel } from './labels';

/** The server's source, from the repository root or from the app (as the SSO tests read it). */
const serverSource = (file: string) => {
  const path = [`apps/server/src/${file}`, `../server/src/${file}`]
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return readFileSync(path ?? file, 'utf8');
};

describe('the import labels', () => {
  it('[IMP-010] names every kind the server imports, in its order', () => {
    const model = serverSource('import/model.ts');
    const from = model.indexOf('export const ENTITY_KINDS = [');
    expect(from).toBeGreaterThanOrEqual(0);
    const block = model.slice(from, model.indexOf('] as const', from));
    const server = [...block.matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]);
    expect(server.length).toBeGreaterThan(30);
    expect(IMPORT_KINDS.filter((k) => k !== 'source')).toEqual(server);
    for (const kind of IMPORT_KINDS) {
      expect(kindLabel(kind), kind).toBe(`admin.imports.kind.${kind}`);
      expect(messagesEn[kindLabel(kind)], kind).toBeTruthy();
    }
  });

  it('[IMP-010] names checklists as checklists, not as something else', () => {
    expect(kindLabel('checklist')).toBe('admin.imports.kind.checklist');
    expect(kindLabel('something new')).toBe('admin.imports.kind.other');
  });
});

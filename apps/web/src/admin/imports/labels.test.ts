import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../../i18n/I18nProvider';
import { type Locale, messagesFor } from '../../i18n/locale';
import { messagesEn } from '../../i18n/messages.en';
import { messagesEs } from '../../i18n/messages.es';
import {
  EXPLAINED_WARNINGS,
  IMPORT_KINDS,
  kindLabel,
  warningExample,
  warningExplanation,
} from './labels';

const translate = (locale: Locale): Translate => {
  const intl = createIntl({ locale, messages: messagesFor(locale) });
  return (id, values) => intl.formatMessage({ id }, values);
};

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

  it('[IMP-012] [NFR-006] explains every warning it lists, the CSV file read as Windows-1252 among them (T-263)', () => {
    for (const code of EXPLAINED_WARNINGS) {
      expect(messagesEn[warningExplanation(code)], code).toBeTruthy();
      expect(messagesEs[warningExplanation(code)], code).toBeTruthy();
    }
    // The code is the CSV source's own, as the server writes it.
    expect(serverSource('import/csv.ts')).toContain("code: 'read_as_windows_1252'");
    expect(warningExplanation('read_as_windows_1252')).toBe(
      'admin.imports.warning.read_as_windows_1252',
    );
    expect(messagesEn['admin.imports.warning.read_as_windows_1252']).toContain('CSV UTF-8');
  });

  it('[IMP-012] [NFR-006] says which lines of a Windows-1252 file to check in the reader’s language (T-263)', () => {
    const es = translate('es');
    // The server sends the line and its word as data.
    expect(warningExample(es, 'read_as_windows_1252', '2: Árbol')).toBe('línea 2: Árbol');
    expect(warningExample(translate('en'), 'read_as_windows_1252', '2: Árbol')).toBe(
      'line 2: Árbol',
    );
    // A report written before keeps its English word out too.
    expect(warningExample(es, 'read_as_windows_1252', 'line 5: Señal')).toBe('línea 5: Señal');
    // Other warnings' examples are data, shown as they are.
    expect(warningExample(es, 'merged_into', '10042: 7')).toBe('10042: 7');
  });
});

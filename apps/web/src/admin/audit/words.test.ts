import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../../i18n/I18nProvider';
import { messagesFor } from '../../i18n/locale';
import { auditActionWords } from './words';

/** The server's source folder, from the repository root or from the app (as the SSO tests read it). */
const SERVER_SRC =
  ['apps/server/src', '../server/src'].map((p) => resolve(process.cwd(), p)).find(existsSync) ??
  'apps/server/src';

const serverSource = (file: string) => readFileSync(join(SERVER_SRC, file), 'utf8');

/**
 * Actions the server writes as a literal beside the lists (`action: 'audit.syslog_test'`), in any
 * of its source files but the tests: a new one is held to words as soon as it is written. Any
 * quote counts; a code is two words joined by a dot, as every audit action is.
 */
function literalActions(): string[] {
  const files = readdirSync(SERVER_SRC, { recursive: true, encoding: 'utf8' }).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  return files.flatMap((file) =>
    [...serverSource(file).matchAll(/\baction:\s*['"`]([a-z_]+\.[a-z_]+)['"`]/g)].map(
      (m) => m[1] as string,
    ),
  );
}

/** The literal strings of the block that starts with `start` and ends at the first `end`. */
function codesIn(file: string, start: string, end: string, pattern: RegExp): string[] {
  const text = serverSource(file);
  const from = text.indexOf(start);
  expect(from, `${start} in ${file}`).toBeGreaterThanOrEqual(0);
  const block = text.slice(from, text.indexOf(end, from));
  return [...block.matchAll(pattern)].map((m) => m[1] as string);
}

/**
 * Every action the server can write to the audit log or its syslog stream: the domain events it
 * records, the records written straight to the log, repeated refusals of access
 * (`audit/subscriber.ts`, `audit/record.ts`, `security/alerts.ts`) and the actions written as a
 * literal, such as the syslog test message (`routes/audit.ts`).
 */
const SERVER_ACTIONS = [
  ...codesIn(
    'audit/subscriber.ts',
    'export const AUDITED_EVENTS = [',
    '] as const',
    /^\s*'([a-z_]+\.[a-z_]+)',/gm,
  ),
  ...codesIn(
    'audit/record.ts',
    'export const AUDIT_ACTIONS = {',
    '} as const',
    /^\s*[a-zA-Z]+: '([a-z_]+\.[a-z_]+)',/gm,
  ),
  ...codesIn(
    'security/alerts.ts',
    'export const REFUSALS_AUDIT_ACTION',
    ';',
    /'([a-z_]+\.[a-z_]+)'/g,
  ),
  ...literalActions(),
];

const translate = (locale: 'en' | 'es'): Translate => {
  const intl = createIntl({ locale, messages: messagesFor(locale) });
  return (id, values) => intl.formatMessage({ id }, values);
};

describe('the audit actions in words (D19)', () => {
  it('[IAM-013] reads every action the server writes in words, in English and Spanish (S3-AD-1)', () => {
    expect(SERVER_ACTIONS.length).toBeGreaterThan(250);
    expect(SERVER_ACTIONS).toContain('password_link.rejected');
    expect(SERVER_ACTIONS).toContain('access.refused_repeatedly');
    expect(SERVER_ACTIONS).toContain('audit.syslog_test');
    for (const locale of ['en', 'es'] as const) {
      const t = translate(locale);
      const raw = SERVER_ACTIONS.filter((code) => {
        const words = auditActionWords(t, code);
        return words === code || words.includes('_');
      });
      expect(raw, `${locale}: actions shown as codes`).toEqual([]);
    }
  });

  it('[IAM-013] names the security actions an auditor looks for first (S3-AD-1)', () => {
    const en = translate('en');
    const es = translate('es');
    expect(auditActionWords(en, 'password_link.rejected')).toBe('Password link refused');
    expect(auditActionWords(es, 'password_link.rejected')).toBe('Enlace de contraseña: rechazo');
    expect(auditActionWords(en, 'session.locked_out')).toBe('Sign-in locked after failed attempts');
    expect(auditActionWords(en, 'user.password_check_failed')).toBe('Password check failed');
    expect(auditActionWords(en, 'sso.sign_in_refused')).toBe('Sign-in by single sign-on refused');
    expect(auditActionWords(en, 'audit.partition_dropped')).toBe(
      'Old records removed by retention',
    );
    expect(auditActionWords(es, 'session.locked_out')).toBe(
      'Inicio de sesión bloqueado tras intentos fallidos',
    );
  });

  it('[IAM-013] says a password change without the subject in front (S3-AD-4)', () => {
    expect(auditActionWords(translate('en'), 'user.password_changed')).toBe('Password changed');
    expect(auditActionWords(translate('es'), 'user.password_changed')).toBe('Contraseña cambiada');
    expect(auditActionWords(translate('en'), 'ticket_template.created')).toBe(
      'Ticket template created',
    );
  });

  it('[IAM-013] says which track role was given or taken, and to whom (S3-AD-4)', () => {
    const en = translate('en');
    const es = translate('es');
    const given = 'track_role.actor_added';
    const taken = 'track_role.actor_removed';
    expect(auditActionWords(en, given, { role: 'Reviewers', person: 'Ada Lovelace' })).toBe(
      'Track role “Reviewers” given to Ada Lovelace',
    );
    expect(auditActionWords(en, taken, { role: 'Reviewers', group: 'Night shift' })).toBe(
      'Track role “Reviewers” taken from the group “Night shift”',
    );
    // An erased person is not named by the server: the role still is.
    expect(auditActionWords(en, given, { role: 'Reviewers' })).toBe(
      'Track role “Reviewers” given to someone',
    );
    expect(auditActionWords(es, given, { role: 'Revisores', person: 'Ada' })).toBe(
      'Rol de track «Revisores» asignado a Ada',
    );
    expect(auditActionWords(es, taken, { role: 'Revisores', group: 'Noche' })).toBe(
      'Rol de track «Revisores» retirado al grupo «Noche»',
    );
    // A role since deleted: the words without names.
    expect(auditActionWords(en, given)).toBe('Track role given to someone');
  });
});

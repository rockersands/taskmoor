import { useMigratedDatabase } from '@taskmoor/db/testing';
import { describe, expect, it } from 'vitest';
import { loadConfig, type SmtpConfig } from '../config';
import { SMTP_KEY, writeSetting } from '../setup';
import { effectiveSmtp, storedSmtp } from './smtp';

const DB = 'postgres://taskmoor:placeholder@db:5432/taskmoor';
// Placeholders only: real credentials come from the environment at run time.
const PASSWORD = 'placeholder-password';
const FORM = { host: 'mail.example.com', port: 587, secure: false, from: 'ops@example.com' };

describe('the mail server the setup form saves (OPS-001)', () => {
  it('[OPS-001] sends through the form’s server, signing in with TASKMOOR_SMTP_PASSWORD', () => {
    expect(storedSmtp(FORM, undefined)).toEqual({
      url: 'smtp://mail.example.com:587',
      user: undefined,
      password: undefined,
      from: 'ops@example.com',
    });
    expect(storedSmtp({ ...FORM, secure: true, port: 465, user: 'ops' }, PASSWORD)).toEqual({
      url: 'smtps://mail.example.com:465',
      user: 'ops',
      password: PASSWORD,
      from: 'ops@example.com',
    });
    expect(storedSmtp({ ...FORM, host: '2001:db8::25' }, undefined)?.url).toBe(
      'smtp://[2001:db8::25]:587',
    );
  });

  it('[OPS-001] sends nothing without a server, or for a user without a password', () => {
    expect(storedSmtp(undefined, PASSWORD)).toBeNull();
    expect(storedSmtp({ ...FORM, user: 'ops' }, undefined)).toBeNull();
  });

  it('[OPS-001] takes TASKMOOR_SMTP_PASSWORD alone for the form’s user, and pairs it otherwise', () => {
    expect(loadConfig({ DATABASE_URL: DB, TASKMOOR_SMTP_PASSWORD: PASSWORD }).smtpPassword).toBe(
      PASSWORD,
    );
    expect(() => loadConfig({ DATABASE_URL: DB, TASKMOOR_SMTP_USER: 'ops' })).toThrow(
      /TASKMOOR_SMTP_USER and TASKMOOR_SMTP_PASSWORD go together/,
    );
    expect(() =>
      loadConfig({
        DATABASE_URL: DB,
        TASKMOOR_SMTP_URL: 'smtp://mail.example.com:587',
        TASKMOOR_SMTP_PASSWORD: PASSWORD,
      }),
    ).toThrow(/go together/);
  });

  describe('with a database', () => {
    const database = useMigratedDatabase();

    it('[OPS-001] prefers TASKMOOR_SMTP_URL, then reads the form’s server on every run', async () => {
      const env: SmtpConfig = {
        url: 'smtp://relay.example.com:25',
        user: undefined,
        password: undefined,
        from: 'Taskmoor <t@example.com>',
      };
      expect(await effectiveSmtp(database.db, env, undefined)).toBe(env);
      expect(await effectiveSmtp(database.db, undefined, undefined)).toBeNull();
      // Saved by the setup form after the server started: the next run uses it.
      await writeSetting(database.db, SMTP_KEY, { ...FORM, user: 'ops' });
      expect(await effectiveSmtp(database.db, undefined, undefined)).toBeNull();
      expect(await effectiveSmtp(database.db, undefined, PASSWORD)).toMatchObject({
        url: 'smtp://mail.example.com:587',
        user: 'ops',
        from: 'ops@example.com',
      });
    });
  });
});

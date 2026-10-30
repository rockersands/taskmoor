import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { SmtpConfig } from '../config';
import { readSetting, SMTP_KEY } from '../setup';

/** The outgoing mail server the first-run setup form saves (OPS-001). */
export interface StoredSmtp {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  from: string;
}

/**
 * The setup form's mail server as the mailer's configuration, signing in with
 * TASKMOOR_SMTP_PASSWORD: the password never leaves the environment, so the form does not ask
 * for it. Null without a server, or when the form names a user and there is no password.
 */
export function storedSmtp(
  stored: StoredSmtp | undefined,
  password: string | undefined,
): SmtpConfig | null {
  if (!stored?.host || !stored.from) return null;
  if (stored.user && !password) return null;
  const host = stored.host.includes(':') ? `[${stored.host}]` : stored.host;
  return {
    url: `${stored.secure ? 'smtps' : 'smtp'}://${host}:${stored.port}`,
    user: stored.user || undefined,
    password: stored.user ? password : undefined,
    from: stored.from,
  };
}

/**
 * The SMTP server notification emails go through (M1-057): TASKMOOR_SMTP_URL and its companions
 * when set, otherwise what the first-run setup form saved. Read on every delivery run, so mail
 * set up after the server started is used without a restart.
 */
export async function effectiveSmtp(
  db: Kysely<Database>,
  env: SmtpConfig | undefined,
  password: string | undefined,
): Promise<SmtpConfig | null> {
  if (env) return env;
  return storedSmtp(await readSetting<StoredSmtp>(db, SMTP_KEY), password);
}

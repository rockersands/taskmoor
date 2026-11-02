import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { countFailedSignIn } from '../security/alerts';
import { type AuditEntry, appendAudit } from './chain';

/**
 * Audit records that are not domain events (M1-003, ADR-034). Domain events cover every
 * successful change; these cover what changes nothing but still matters: refused sign-ins (by
 * password, directory, second factor, recovery code, API token or Basic authentication, ADR-109)
 * and the lockouts they cause, refused password checks and links, repeated refusals of access
 * (`access.refused_repeatedly`, written by `security/alerts.ts`), reading the whole log out, and
 * retention dropping old records. They are written straight to the log, in the request. What
 * was typed as a secret is never in them.
 */
export const AUDIT_ACTIONS = {
  signInFailed: 'session.sign_in_failed',
  lockedOut: 'session.locked_out',
  passwordCheckFailed: 'user.password_check_failed',
  passwordLinkRejected: 'password_link.rejected',
  ssoRefused: 'sso.sign_in_refused',
  exported: 'audit.exported',
  partitionDropped: 'audit.partition_dropped',
} as const;

/** The submitted email when it looks like one; anything else may be a mistyped password. */
function submittedEmail(email: string): { email: string } | { emailMalformed: true } {
  const value = email.trim().toLowerCase().slice(0, 320);
  return /^[^\s@]+@[^\s@]+$/.test(value) ? { email: value } : { emailMalformed: true };
}

/**
 * How a refused attempt tried to authenticate (ASVS 7.2.1; ADR-109): a password checked here or
 * by a directory (LDAP, Active Directory), a second factor (`totp`, `webauthn`,
 * `recovery_code`, or a code at the enrolment a policy demands), an API token sent as a bearer
 * token, or Basic authentication on the Jira-compatible API.
 */
export type AttemptMethod =
  | 'password'
  | 'directory'
  | 'totp'
  | 'webauthn'
  | 'recovery_code'
  | 'enrollment'
  | 'api_token'
  | 'basic';

/**
 * Why an attempt was refused. `wrong_password` and `unknown_account` are told apart here only:
 * the person who tried gets the same answer for both.
 */
export type AttemptReason =
  | 'wrong_password'
  | 'unknown_account'
  | 'second_factor'
  | 'sso_required'
  | 'directory_unavailable'
  | 'token_unknown'
  | 'token_expired'
  | 'token_revoked'
  | 'token_owner_deactivated'
  | 'email_mismatch'
  | 'not_a_token';

export interface RefusedAttempt {
  workspaceId: number;
  ip: string;
  /** The client's User-Agent, cut to 400 characters. */
  userAgent?: string | null;
  /** The person signed in, for a refused password check; null for a sign-in. */
  actorId: number | null;
  /** The account the attempt was for, when it exists and is active. */
  userId: number | null;
  /** What was typed as the email, for sign-ins. */
  email?: string;
  /** The lock now in force after this failure, if it caused one. */
  lockedUntil: Date | null;
  /**
   * Why. Left out, a wrong password (or, without an account, `unknown_account`);
   * `directory_unavailable` means the directory managing the account could not be reached
   * (M1-082), which decides nothing.
   */
  reason?: AttemptReason;
  /** How it tried; a password unless said. */
  method?: AttemptMethod;
  /** The API token tried, when it is one Taskmoor knows (expired, revoked...): its id only. */
  tokenId?: number;
  /**
   * Whether it counts towards the alert rules (ADR-109); true unless the directory was
   * unavailable. Sign-in passes false for a right password refused because of single sign-on.
   */
  countsForAlerts?: boolean;
}

/** Records a refused sign-in or password check, and the lockout it caused, if any. */
export async function recordRefusedAttempt(
  db: Kysely<Database>,
  action: typeof AUDIT_ACTIONS.signInFailed | typeof AUDIT_ACTIONS.passwordCheckFailed,
  attempt: RefusedAttempt,
): Promise<void> {
  const subject = attempt.userId === null ? {} : { subjectType: 'user', subjectId: attempt.userId };
  const reason: AttemptReason =
    attempt.reason ?? (attempt.userId === null ? 'unknown_account' : 'wrong_password');
  const typed = {
    ...(attempt.email === undefined ? {} : submittedEmail(attempt.email)),
    reason,
    method: attempt.method ?? 'password',
    ...(attempt.tokenId !== undefined ? { tokenId: attempt.tokenId } : {}),
    ...(attempt.userAgent ? { userAgent: attempt.userAgent.slice(0, 400) } : {}),
  };
  const base = { workspaceId: attempt.workspaceId, actorId: attempt.actorId, ip: attempt.ip };
  const entries: AuditEntry[] = [{ ...base, ...subject, action, details: typed }];
  if (attempt.lockedUntil) {
    entries.push({
      ...base,
      ...subject,
      action: AUDIT_ACTIONS.lockedOut,
      details: { ...typed, until: attempt.lockedUntil.toISOString() },
    });
  }
  await appendAudit(db, entries);
  if (attempt.countsForAlerts ?? reason !== 'directory_unavailable') {
    await countFailedSignIn(db, attempt.workspaceId, {
      userId: attempt.userId,
      ...(attempt.email !== undefined ? { email: attempt.email } : {}),
      ip: attempt.ip,
    });
  }
}

/** Records a password link that was not accepted (unknown, used or expired). */
export async function recordRejectedLink(
  db: Kysely<Database>,
  attempt: { workspaceId: number; ip: string; lockedUntil: Date | null },
): Promise<void> {
  const base = { workspaceId: attempt.workspaceId, actorId: null, ip: attempt.ip };
  const entries: AuditEntry[] = [{ ...base, action: AUDIT_ACTIONS.passwordLinkRejected }];
  if (attempt.lockedUntil) {
    entries.push({
      ...base,
      action: AUDIT_ACTIONS.lockedOut,
      details: { until: attempt.lockedUntil.toISOString() },
    });
  }
  await appendAudit(db, entries);
}

/**
 * Records a single sign-on the provider completed but Taskmoor refused (unverified address, a
 * domain the provider does not serve, no account, a deactivated account). Failures before the
 * provider vouched for someone are not recorded: anyone can produce those.
 */
export async function recordSsoRefusal(
  db: Kysely<Database>,
  attempt: {
    workspaceId: number;
    ip: string;
    providerId: number;
    userId: number | null;
    email: string | null;
    reason: string;
  },
): Promise<void> {
  await appendAudit(db, [
    {
      workspaceId: attempt.workspaceId,
      actorId: null,
      ip: attempt.ip,
      ...(attempt.userId === null ? {} : { subjectType: 'user', subjectId: attempt.userId }),
      action: AUDIT_ACTIONS.ssoRefused,
      details: {
        providerId: attempt.providerId,
        reason: attempt.reason,
        ...(attempt.email ? submittedEmail(attempt.email) : {}),
      },
    },
  ]);
}

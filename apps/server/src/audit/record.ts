import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { type AuditEntry, appendAudit } from './chain';

/**
 * Audit records that are not domain events (M1-003, ADR-034). Domain events cover every
 * successful change; these cover what changes nothing but still matters: refused sign-ins and
 * the lockouts they cause, refused password checks and links, reading the whole log out, and
 * retention dropping old records. They are written straight to the log, in the request.
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

export interface RefusedAttempt {
  workspaceId: number;
  ip: string;
  /** The person signed in, for a refused password check; null for a sign-in. */
  actorId: number | null;
  /** The account the attempt was for, when it exists and is active. */
  userId: number | null;
  /** What was typed as the email, for sign-ins. */
  email?: string;
  /** The lock now in force after this failure, if it caused one. */
  lockedUntil: Date | null;
  /** Why, when it was not a wrong password: `second_factor`, `sso_required`. */
  reason?: 'second_factor' | 'sso_required';
}

/** Records a refused sign-in or password check, and the lockout it caused, if any. */
export async function recordRefusedAttempt(
  db: Kysely<Database>,
  action: typeof AUDIT_ACTIONS.signInFailed | typeof AUDIT_ACTIONS.passwordCheckFailed,
  attempt: RefusedAttempt,
): Promise<void> {
  const subject = attempt.userId === null ? {} : { subjectType: 'user', subjectId: attempt.userId };
  const typed = {
    ...(attempt.email === undefined ? {} : submittedEmail(attempt.email)),
    ...(attempt.reason ? { reason: attempt.reason } : {}),
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

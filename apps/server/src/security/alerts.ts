import type { Database, SecurityAlertRuleName } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { appendAudit } from '../audit/chain';
import { emit } from '../events/bus';

/**
 * Alert rules over security events (ASVS 11.1.7, 11.1.8; ADR-109). Each rule counts one kind
 * of event per key in fixed windows and raises one alert when a key's count reaches the
 * threshold within a window:
 *
 * - `sign_in_failures_account`: failed sign-ins and password checks for one account (by the
 *   account, or by the email typed when no account matches);
 * - `sign_in_failures_address`: failed sign-ins, password checks and refused API tokens from
 *   one client address;
 * - `access_refusals`: refused requests (403) of one person or one API token;
 * - `bulk_exports`: workspace, audit log and search result exports by one person.
 *
 * An alert is raised once per rule, key and window (`security_alert`), emitted as
 * `security.alert_raised` (audited, and the site administrators hear of it in their inbox and
 * by email: `notices.ts`). Counting goes on whatever a rule's switch says, so the refusal
 * audit below keeps working when its alert is off.
 *
 * Sign-in attempts refused while an account or address is locked are not counted: the
 * throttle already refuses them unchecked, and an attacker could otherwise fill the counters.
 */
export const ALERT_RULES = [
  'sign_in_failures_account',
  'sign_in_failures_address',
  'access_refusals',
  'bulk_exports',
] as const satisfies readonly SecurityAlertRuleName[];
export type AlertRule = (typeof ALERT_RULES)[number];

export interface AlertRuleSetting {
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
}
export type AlertRules = Record<AlertRule, AlertRuleSetting>;

/**
 * The defaults: below the sign-in throttle's own limits (an account locks progressively after
 * 5 failures, which lets about 12 through in an hour; an address locks at 50 in 15 minutes), so
 * an attack is reported before the throttle hides its later attempts.
 */
export const DEFAULT_ALERT_RULES: AlertRules = {
  sign_in_failures_account: { enabled: true, threshold: 10, windowMinutes: 60 },
  sign_in_failures_address: { enabled: true, threshold: 25, windowMinutes: 15 },
  access_refusals: { enabled: true, threshold: 50, windowMinutes: 15 },
  bulk_exports: { enabled: true, threshold: 5, windowMinutes: 60 },
};

export const ALERT_RULE_LIMITS = {
  threshold: { min: 1, max: 100_000 },
  windowMinutes: { min: 1, max: 1440 },
} as const;

const ruleSetting = z
  .object({
    enabled: z.boolean(),
    threshold: z
      .number()
      .int()
      .min(ALERT_RULE_LIMITS.threshold.min)
      .max(ALERT_RULE_LIMITS.threshold.max),
    windowMinutes: z
      .number()
      .int()
      .min(ALERT_RULE_LIMITS.windowMinutes.min)
      .max(ALERT_RULE_LIMITS.windowMinutes.max),
  })
  .strict();

/** What `PUT /api/v1/security/alerts` takes: any of the rules, each whole. */
export const alertRulesInput = z
  .object({
    rules: z
      .object(
        Object.fromEntries(ALERT_RULES.map((r) => [r, ruleSetting.optional()])) as Record<
          AlertRule,
          z.ZodOptional<typeof ruleSetting>
        >,
      )
      .strict(),
  })
  .strict();

/**
 * Refused requests are audited in aggregate (ASVS 7.2.2): one record when a person's or a
 * token's refusals in the window reach this count, and one more at each tenfold (100, 1,000...),
 * so a flood of refusals writes a handful of records, not one per request.
 */
export const REFUSAL_AUDIT_AT = 10;

export const REFUSALS_AUDIT_ACTION = 'access.refused_repeatedly';

type Db = Kysely<Database> | Transaction<Database>;

/** Read on every failed sign-in and refusal, so kept per process for a few seconds. */
const CACHE_MS = 15_000;
const cache = new Map<number, { at: number; rules: AlertRules }>();

export async function alertRules(db: Db, workspaceId: number): Promise<AlertRules> {
  const hit = cache.get(workspaceId);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.rules;
  const rows = await db
    .selectFrom('security_alert_rule')
    .select(['rule', 'enabled', 'threshold', 'window_minutes'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  const rules: AlertRules = { ...DEFAULT_ALERT_RULES };
  for (const row of rows) {
    if (!(ALERT_RULES as readonly string[]).includes(row.rule)) continue;
    rules[row.rule as AlertRule] = {
      enabled: row.enabled,
      threshold: row.threshold,
      windowMinutes: row.window_minutes,
    };
  }
  cache.set(workspaceId, { at: now, rules });
  return rules;
}

/** Drops this process's copy after a change. */
export function forgetAlertRules(workspaceId: number): void {
  cache.delete(workspaceId);
}

/** Who or what a count is about, as the alert names it. Never a secret. */
export interface AlertSubject {
  userId?: number | null;
  tokenId?: number | null;
  address?: string | null;
  email?: string | null;
}

/** The fixed window `at` falls in. */
export function windowStart(at: Date, windowMinutes: number): Date {
  const size = windowMinutes * 60_000;
  return new Date(Math.floor(at.getTime() / size) * size);
}

/** Adds one to a rule's count for a key in the current window; returns the count. */
async function bump(
  db: Db,
  workspaceId: number,
  rule: AlertRule,
  key: string,
  start: Date,
): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    INSERT INTO security_counter (workspace_id, rule, key, window_start, count)
    VALUES (${workspaceId}, ${rule}, ${key}, ${start}, 1)
    ON CONFLICT (workspace_id, rule, key, window_start)
      DO UPDATE SET count = security_counter.count + 1
    RETURNING count`.execute(db);
  return rows[0]?.count ?? 1;
}

/** Raises the alert of a rule for a key and window, once; true when this call raised it. */
async function raise(
  db: Kysely<Database>,
  workspaceId: number,
  rule: AlertRule,
  key: string,
  setting: AlertRuleSetting,
  start: Date,
  count: number,
  subject: AlertSubject,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const raised = await trx
      .insertInto('security_alert')
      .values({
        workspace_id: workspaceId,
        rule,
        key,
        window_start: start,
        count,
        threshold: setting.threshold,
        window_minutes: setting.windowMinutes,
        details: JSON.stringify(subject),
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'rule', 'key', 'window_start']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!raised) return false;
    // Raised by the system, in the request that reached the threshold: the event keeps that
    // request's address; the payload names whom the alert is about.
    await emit(
      trx,
      { workspaceId, actorId: null },
      {
        type: 'security.alert_raised',
        subjectId: raised.id,
        payload: {
          rule,
          count,
          threshold: setting.threshold,
          windowMinutes: setting.windowMinutes,
          windowStart: start.toISOString(),
          userId: subject.userId ?? null,
          tokenId: subject.tokenId ?? null,
          address: subject.address ?? null,
          email: subject.email ?? null,
        },
      },
    );
    return true;
  });
}

/**
 * Counts one event for a rule and key, and raises the rule's alert when the count reaches its
 * threshold. Returns the count in the window and the window's start.
 */
export async function countForAlert(
  db: Kysely<Database>,
  workspaceId: number,
  rule: AlertRule,
  key: string,
  subject: AlertSubject,
  now = new Date(),
): Promise<{ count: number; windowStart: Date; windowMinutes: number }> {
  const setting = (await alertRules(db, workspaceId))[rule];
  const start = windowStart(now, setting.windowMinutes);
  const count = await bump(db, workspaceId, rule, key, start);
  // `>=` rather than `===`: a threshold lowered mid-window still fires; the unique key keeps it
  // to one alert per window.
  if (setting.enabled && count >= setting.threshold) {
    await raise(db, workspaceId, rule, key, setting, start, count, subject);
  }
  return { count, windowStart: start, windowMinutes: setting.windowMinutes };
}

/** The account key of a sign-in: the account when one matched, else the email typed. */
export function accountKey(userId: number | null, email: string | undefined): string | null {
  if (userId !== null) return `user:${userId}`;
  const typed = email?.trim().toLowerCase().slice(0, 320);
  return typed ? `email:${typed}` : null;
}

/**
 * A failed sign-in, password check or API token, counted for the account (when known or typed)
 * and the client address. Errors are the caller's: these run in the request that failed.
 */
export async function countFailedSignIn(
  db: Kysely<Database>,
  workspaceId: number,
  attempt: { userId: number | null; email?: string; ip: string },
  now = new Date(),
): Promise<void> {
  // Without an account, only what looks like an email is a key: text in the email field that
  // is not one may be a password typed in the wrong box.
  const email =
    attempt.userId === null && attempt.email && /^[^\s@]+@[^\s@]+$/.test(attempt.email.trim())
      ? attempt.email.trim().toLowerCase().slice(0, 320)
      : null;
  const key =
    attempt.userId !== null
      ? accountKey(attempt.userId, undefined)
      : email && accountKey(null, email);
  if (key) {
    await countForAlert(
      db,
      workspaceId,
      'sign_in_failures_account',
      key,
      { userId: attempt.userId, email, address: attempt.ip },
      now,
    );
  }
  await countForAlert(
    db,
    workspaceId,
    'sign_in_failures_address',
    `ip:${attempt.ip}`,
    { address: attempt.ip },
    now,
  );
}

/** A bulk export by a person (workspace, audit log or search results). */
export async function countBulkExport(
  db: Kysely<Database>,
  workspaceId: number,
  userId: number,
  now = new Date(),
): Promise<void> {
  await countForAlert(db, workspaceId, 'bulk_exports', `user:${userId}`, { userId }, now);
}

/**
 * A refused request (403) of a signed-in person or an API token: counted for the alert, and
 * audited in aggregate at REFUSAL_AUDIT_AT and each tenfold after it within the window.
 */
export async function countRefusal(
  db: Kysely<Database>,
  workspaceId: number,
  refusal: {
    userId: number;
    tokenId: number | null;
    ip: string;
    method: string;
    route: string | null;
  },
  now = new Date(),
): Promise<void> {
  const key = refusal.tokenId !== null ? `token:${refusal.tokenId}` : `user:${refusal.userId}`;
  const {
    count,
    windowStart: start,
    windowMinutes,
  } = await countForAlert(
    db,
    workspaceId,
    'access_refusals',
    key,
    { userId: refusal.userId, tokenId: refusal.tokenId, address: refusal.ip },
    now,
  );
  if (!isAuditCount(count)) return;
  await appendAudit(db, [
    {
      workspaceId,
      action: REFUSALS_AUDIT_ACTION,
      actorId: refusal.userId,
      subjectType: refusal.tokenId !== null ? 'api_token' : 'user',
      subjectId: refusal.tokenId ?? refusal.userId,
      ip: refusal.ip,
      details: {
        count,
        windowStart: start.toISOString(),
        windowMinutes,
        // The request that reached the count, by its route pattern: never its parameters.
        lastRoute: refusal.route ? `${refusal.method} ${refusal.route}` : refusal.method,
      },
    },
  ]);
}

/** REFUSAL_AUDIT_AT, or a tenfold of it: 10, 100, 1,000... */
export function isAuditCount(count: number): boolean {
  let n = count;
  while (n > REFUSAL_AUDIT_AT && n % 10 === 0) n /= 10;
  return n === REFUSAL_AUDIT_AT;
}

/**
 * Drops counters older than two days (the longest window is one) and security emails sent more
 * than 30 days ago; the audit log keeps what they were about.
 */
export async function pruneSecurityData(db: Kysely<Database>, now = new Date()) {
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  await db.deleteFrom('security_counter').where('window_start', '<', twoDaysAgo).execute();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await db.deleteFrom('security_email').where('sent_at', '<', monthAgo).execute();
}

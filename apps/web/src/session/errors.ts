import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

/** The default password policy of IAM-001; the backend checks it and answers with codes. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const PROBLEM_MESSAGES = new Map<string, MessageId>([
  ['too_short', 'password.problem.too_short'],
  ['too_long', 'password.problem.too_long'],
  ['common', 'password.problem.common'],
  ['predictable', 'password.problem.predictable'],
  ['contains_identity', 'password.problem.contains_identity'],
]);

/**
 * "Too many attempts. Try again in 2 minutes." Minutes are rounded up; under a minute the
 * message counts seconds. Without a usable wait it says "later".
 */
export function retryMessage(t: Translate, seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return t('auth.tooManyAttemptsLater');
  }
  const whole = Math.ceil(seconds);
  if (whole < 60) return t('auth.tooManyAttemptsSeconds', { seconds: whole });
  return t('auth.tooManyAttemptsMinutes', { minutes: Math.ceil(whole / 60) });
}

/** The lockout message for a 429 answer (IAM-001), or null for any other error. */
export function tooManyAttemptsMessage(t: Translate, error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const body = error.body as { retryAfterSeconds?: unknown } | null;
  const seconds = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : null;
  return retryMessage(t, seconds);
}

/**
 * One translated sentence per password problem in a `weak_password` (or `invalid_request`)
 * answer. A code this frontend does not know yet falls back to the backend's own sentence.
 */
export function passwordProblemMessages(t: Translate, body: unknown): string[] {
  const { codes, problems } = (body ?? {}) as { codes?: unknown; problems?: unknown };
  const sentences = Array.isArray(problems)
    ? problems.filter((p): p is string => typeof p === 'string')
    : [];
  if (!Array.isArray(codes)) return sentences;
  return codes.map((code, index) => {
    const id = typeof code === 'string' ? PROBLEM_MESSAGES.get(code) : undefined;
    if (id) return t(id, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH });
    return sentences[index] ?? String(code);
  });
}

import { dictionary } from '@zxcvbn-ts/language-common';

/**
 * The password policy of IAM-001 and ASVS V2.1: a minimum length (12 by default), a generous
 * maximum, any characters including spaces and emoji, no composition rules, and an offline
 * check against passwords known from breaches. The list is the 49,000-entry common-password
 * dictionary of zxcvbn-ts (MIT), built from breach corpora; few of its entries reach 12
 * characters, so a common password padded with digits or symbols, a repeated pattern and a
 * plain sequence are refused as well.
 */
export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
}

/** ASVS 2.1.2: at least 64 characters allowed, more than 128 refused. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 12, maxLength: 128 };

/** IAM-001: the default policy's minimum. */
export const PASSWORD_MIN_LENGTH = DEFAULT_PASSWORD_POLICY.minLength;

export type PasswordProblem =
  | 'too_short'
  | 'too_long'
  | 'common'
  | 'predictable'
  | 'contains_identity';

export interface PasswordContext {
  policy?: PasswordPolicy;
  /** Words the password must not contain: the person's email, name and the like. */
  identity?: readonly string[];
}

let common: ReadonlySet<string> | undefined;

function commonPasswords(): ReadonlySet<string> {
  common ??= new Set(dictionary['passwords-common'].map((p) => p.toLowerCase()));
  return common;
}

/** Words every install refuses inside a password. */
const PRODUCT_WORDS = ['taskmoor'];

export function checkPassword(password: string, context: PasswordContext = {}): PasswordProblem[] {
  const policy = context.policy ?? DEFAULT_PASSWORD_POLICY;
  const normal = password.normalize('NFKC');
  const length = [...normal].length;
  const problems: PasswordProblem[] = [];
  if (length < policy.minLength) problems.push('too_short');
  if (length > policy.maxLength) problems.push('too_long');
  if (problems.length > 0) return problems;

  const lower = normal.toLowerCase();
  if (isCommon(lower)) problems.push('common');
  else if (isPredictable(lower)) problems.push('predictable');
  if (containsIdentity(lower, context.identity ?? [])) problems.push('contains_identity');
  return problems;
}

function isCommon(lower: string): boolean {
  const list = commonPasswords();
  if (list.has(lower)) return true;
  // "monkey2024!!!!" is "monkey" with padding: strip digits, symbols and spaces at both ends.
  const core = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  return core.length >= 4 && core !== lower && list.has(core);
}

function isPredictable(lower: string): boolean {
  const chars = [...lower];
  if (new Set(chars).size < 4) return true;
  // A short block repeated: "abcdabcdabcd".
  for (let size = 1; size <= chars.length / 2; size++) {
    const block = chars.slice(0, size).join('');
    if (block.repeat(Math.ceil(chars.length / size)).startsWith(lower)) return true;
  }
  // A run up or down the alphabet or the digits: "123456789012", "zyxwvutsrqpo".
  let steps = 0;
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]?.codePointAt(0) ?? 0;
    const b = chars[i]?.codePointAt(0) ?? 0;
    const wrap =
      (chars[i - 1] === '9' && chars[i] === '0') || (chars[i - 1] === '0' && chars[i] === '9');
    if (Math.abs(b - a) === 1 || wrap) steps++;
  }
  return steps >= chars.length - 2;
}

function containsIdentity(lower: string, identity: readonly string[]): boolean {
  const words = [...PRODUCT_WORDS];
  for (const item of identity) {
    const value = item.normalize('NFKC').toLowerCase().trim();
    if (!value) continue;
    words.push(value);
    // The parts of an email and of a name count on their own: "kalo" in "kalo@example.com".
    words.push(...value.split(/[@.\s_+-]+/));
  }
  return words.some((w) => w.length >= 4 && lower.includes(w));
}

const MESSAGES: Record<PasswordProblem, (policy: PasswordPolicy) => string> = {
  too_short: (p) => `must be at least ${p.minLength} characters`,
  too_long: (p) => `must be at most ${p.maxLength} characters`,
  common: () => 'is too common: it appears in lists of breached passwords',
  predictable: () => 'is too predictable: a repeated pattern or a sequence',
  contains_identity: () => 'must not contain your name, your email address or the product name',
};

export function describePasswordProblem(
  problem: PasswordProblem,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): string {
  return MESSAGES[problem](policy);
}

/** The problems as sentences, for API responses. */
export function passwordProblems(password: string, context: PasswordContext = {}): string[] {
  return checkPassword(password, context).map((p) =>
    describePasswordProblem(p, context.policy ?? DEFAULT_PASSWORD_POLICY),
  );
}

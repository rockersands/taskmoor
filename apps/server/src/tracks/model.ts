import type { TrackMode, TrackType } from '@taskmoor/db';

/**
 * The track as a domain object (M1-006; CORE-001 to CORE-003, spec 01a section 1.1): key
 * rules, types and modes, and the feature toggles each type turns on by default.
 */

export const TRACK_TYPES = [
  'software',
  'business',
  'service',
  'discovery',
] as const satisfies readonly TrackType[];
export const TRACK_MODES = ['shared', 'local'] as const satisfies readonly TrackMode[];

/** The per-track feature toggles of CORE-002, in the order the spec lists them. */
export const TRACK_FEATURES = [
  'board',
  'backlog',
  'sprints',
  'releases',
  'development',
  'forms',
  'approvals',
  'calendar',
  'timeline',
] as const;
export type TrackFeature = (typeof TRACK_FEATURES)[number];
export type TrackFeatures = Record<TrackFeature, boolean>;

const only = (...on: TrackFeature[]): TrackFeatures =>
  Object.fromEntries(TRACK_FEATURES.map((f) => [f, on.includes(f)])) as TrackFeatures;

/**
 * A type is a preset of toggles (section 1.1). Business tracks have boards, forms, approvals,
 * calendar and timeline; software adds backlog, sprints, releases and development data; service
 * tracks start from the business set (their desk features arrive with file 04a); discovery
 * tracks start with boards, forms and timeline. A track admin changes any toggle later.
 */
export const FEATURE_DEFAULTS: Record<TrackType, TrackFeatures> = {
  software: only(...TRACK_FEATURES),
  business: only('board', 'forms', 'approvals', 'calendar', 'timeline'),
  service: only('board', 'forms', 'approvals', 'calendar', 'timeline'),
  discovery: only('board', 'forms', 'timeline'),
};

/** The column that stores a feature toggle. */
export const featureColumn = (feature: TrackFeature) => `feature_${feature}` as const;

/**
 * Track keys (CORE-001). New keys follow the native rule: an ASCII letter, then letters or
 * digits, 2 to 10 characters. Keys from imported Jira data follow the wider import rule,
 * because a Jira site's administrator can widen its key pattern (underscores, digits, longer
 * keys, single letters): an ASCII letter, then letters, digits or underscores, up to 255
 * characters. Neither rule allows a hyphen, which separates the key from the ticket number
 * (PAY-42). Keys are stored upper case and are unique within a workspace ignoring case, old
 * keys included.
 */
export const KEY_RULES = {
  native: { pattern: /^[A-Z][A-Z0-9]*$/, min: 2, max: 10 },
  import: { pattern: /^[A-Z][A-Z0-9_]*$/, min: 1, max: 255 },
} as const;
export type KeyRule = keyof typeof KEY_RULES;

export type KeyProblem =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'must_start_with_letter'
  | 'invalid_character';

/**
 * Upper-cases ASCII letters only, so no other script changes length or shape on the way (the
 * German sharp s would become SS under toUpperCase) and the result is what the rule checks.
 */
export function normalizeKey(raw: string): string {
  return raw.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
}

export function checkKey(
  raw: string,
  rule: KeyRule = 'native',
): { ok: true; key: string } | { ok: false; problem: KeyProblem } {
  const key = normalizeKey(raw);
  const { pattern, min, max } = KEY_RULES[rule];
  if (key.length === 0) return { ok: false, problem: 'empty' };
  if (!/^[A-Z]/.test(key)) return { ok: false, problem: 'must_start_with_letter' };
  if (!pattern.test(key)) return { ok: false, problem: 'invalid_character' };
  if (key.length < min) return { ok: false, problem: 'too_short' };
  if (key.length > max) return { ok: false, problem: 'too_long' };
  return { ok: true, key };
}

/**
 * Whether a value can be a track key under either rule: lookups accept old and imported keys,
 * which the native rule may reject.
 */
export function looksLikeKey(value: string): boolean {
  return checkKey(value, 'import').ok;
}

/**
 * The AI eval dataset (M1-133; ADR-107): a small workspace that the query, summary and
 * duplicate evals run against.
 *
 * Provenance: synthetic. Written for Taskmoor on 2026-11-01 by the M1-133 task, in our own
 * words; no real person, company, ticket or comment is in it, and nothing was copied from
 * another product. People's names are invented, addresses use the reserved `example.com`.
 * The tickets are generated from the word lists below by a seeded generator, so the same
 * list comes out on every run; the summary cases (`summary-corpus.ts`) join them.
 *
 * To add tickets: append to the word lists or to `HAND_TICKETS`, run the eval tests, and
 * review the reference results that change (`pnpm eval query --json` prints them).
 */
import type {
  CloseReasonName,
  CommentSpec,
  GroupName,
  Handle,
  PriorityName,
  StatusName,
  TicketSpec,
  TrackKey,
  TypeName,
} from './model';
import { SUMMARY_CASES } from './summary-corpus';

export type * from './model';

/** The eval's clock: a Wednesday, so "this week" (from Sunday) has three days behind it. */
export const EVAL_NOW = new Date('2026-09-16T10:00:00.000Z');
/** Everyone in the dataset reads dates in UTC. */
export const EVAL_TIME_ZONE = 'UTC';

export interface Person {
  handle: Handle;
  name: string;
  email: string;
  groups: readonly GroupName[];
  /** The language the person's prompts are written in, most of the time. */
  locale: 'en' | 'es' | 'de' | 'ja';
}

export const PEOPLE: readonly Person[] = [
  {
    handle: 'ana',
    name: 'Ana Ortiz',
    email: 'ana.ortiz@example.com',
    groups: ['web-team'],
    locale: 'es',
  },
  {
    handle: 'ben',
    name: 'Ben Okafor',
    email: 'ben.okafor@example.com',
    groups: ['web-team'],
    locale: 'en',
  },
  {
    handle: 'chen',
    name: 'Chen Wei',
    email: 'chen.wei@example.com',
    groups: ['platform-team', 'security'],
    locale: 'en',
  },
  {
    handle: 'dara',
    name: 'Dara Kowalski',
    email: 'dara.kowalski@example.com',
    groups: ['platform-team'],
    locale: 'de',
  },
  {
    handle: 'elif',
    name: 'Elif Yilmaz',
    email: 'elif.yilmaz@example.com',
    groups: ['mobile-team'],
    locale: 'de',
  },
  {
    handle: 'farid',
    name: 'Farid Haddad',
    email: 'farid.haddad@example.com',
    groups: ['platform-team', 'security'],
    locale: 'en',
  },
  {
    handle: 'grace',
    name: 'Grace Lindqvist',
    email: 'grace.lindqvist@example.com',
    groups: [],
    locale: 'en',
  },
  {
    handle: 'hiro',
    name: 'Hiro Tanaka',
    email: 'hiro.tanaka@example.com',
    groups: ['mobile-team'],
    locale: 'ja',
  },
];

export const GROUPS: readonly GroupName[] = [
  'web-team',
  'platform-team',
  'mobile-team',
  'security',
];

export interface TrackSpec {
  key: TrackKey;
  name: string;
  owner: Handle;
  /** The Members role: create, edit, assign, transition and close. */
  members: readonly Handle[];
  /** The Viewers role: browse and comment only. */
  viewers: readonly Handle[];
  releases: readonly { name: string; shipped: boolean; releaseDate: string }[];
  areas: readonly string[];
}

const EVERYONE: readonly Handle[] = [
  'ana',
  'ben',
  'chen',
  'dara',
  'elif',
  'farid',
  'grace',
  'hiro',
];

/** Three tracks everyone sees; Operations only its three members (and its owner) browse. */
export const TRACKS: readonly TrackSpec[] = [
  {
    key: 'WEB',
    name: 'Web app',
    owner: 'ana',
    members: EVERYONE,
    viewers: [],
    releases: [
      { name: '1.4', shipped: true, releaseDate: '2026-08-04' },
      { name: '1.5', shipped: false, releaseDate: '2026-09-29' },
      { name: '2.0', shipped: false, releaseDate: '2026-12-01' },
    ],
    areas: ['Checkout', 'Search', 'Settings', 'Sign-in'],
  },
  {
    key: 'API',
    name: 'Platform API',
    owner: 'chen',
    members: EVERYONE,
    viewers: [],
    releases: [
      { name: '3.1', shipped: true, releaseDate: '2026-07-21' },
      { name: '3.2', shipped: false, releaseDate: '2026-10-06' },
    ],
    areas: ['Billing', 'Webhooks', 'Auth'],
  },
  {
    key: 'MOB',
    name: 'Mobile apps',
    owner: 'elif',
    members: ['ana', 'ben', 'chen', 'dara', 'elif', 'farid', 'hiro'],
    viewers: ['grace'],
    releases: [
      { name: '5.0', shipped: true, releaseDate: '2026-08-18' },
      { name: '5.1', shipped: false, releaseDate: '2026-10-13' },
    ],
    areas: ['Offline sync', 'Notifications'],
  },
  {
    key: 'OPS',
    name: 'Operations',
    owner: 'farid',
    members: ['chen', 'dara', 'farid'],
    viewers: [],
    releases: [],
    areas: ['Backups', 'Monitoring'],
  },
];

export const LABELS = [
  'frontend',
  'backend',
  'regression',
  'accessibility',
  'performance',
  'customer-reported',
  'security',
  'docs',
  'flaky-test',
  'tech-debt',
  'ios',
  'android',
] as const;

/** A small seeded generator (mulberry32): the dataset is the same on every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A calendar day `days` after `EVAL_NOW` (negative: before), as YYYY-MM-DD. */
export function dayFromNow(days: number): string {
  return new Date(EVAL_NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** What a ticket's summary is made of, per track: the thing it is about and its area. */
const SUBJECTS: Record<TrackKey, readonly { subject: string; area: string | null }[]> = {
  WEB: [
    { subject: 'checkout page', area: 'Checkout' },
    { subject: 'coupon field', area: 'Checkout' },
    { subject: 'payment form', area: 'Checkout' },
    { subject: 'order summary', area: 'Checkout' },
    { subject: 'search results', area: 'Search' },
    { subject: 'search filters', area: 'Search' },
    { subject: 'profile settings', area: 'Settings' },
    { subject: 'notification preferences', area: 'Settings' },
    { subject: 'dark mode toggle', area: 'Settings' },
    { subject: 'login form', area: 'Sign-in' },
    { subject: 'password reset email', area: 'Sign-in' },
    { subject: 'two-factor prompt', area: 'Sign-in' },
    { subject: 'landing page', area: null },
  ],
  API: [
    { subject: 'invoice export', area: 'Billing' },
    { subject: 'tax calculation', area: 'Billing' },
    { subject: 'refund endpoint', area: 'Billing' },
    { subject: 'webhook retries', area: 'Webhooks' },
    { subject: 'webhook delivery log', area: 'Webhooks' },
    { subject: 'token refresh', area: 'Auth' },
    { subject: 'consent screen', area: 'Auth' },
    { subject: 'rate limiter', area: 'Auth' },
    { subject: 'public API docs', area: null },
  ],
  MOB: [
    { subject: 'offline queue', area: 'Offline sync' },
    { subject: 'sync conflict dialog', area: 'Offline sync' },
    { subject: 'photo upload', area: 'Offline sync' },
    { subject: 'push notifications', area: 'Notifications' },
    { subject: 'badge counter', area: 'Notifications' },
    { subject: 'onboarding screens', area: null },
    { subject: 'home screen widget', area: null },
  ],
  OPS: [
    { subject: 'nightly backup job', area: 'Backups' },
    { subject: 'restore drill', area: 'Backups' },
    { subject: 'disk usage alert', area: 'Monitoring' },
    { subject: 'uptime dashboard', area: 'Monitoring' },
    { subject: 'log rotation', area: null },
  ],
};

const BUG_PHRASES = [
  'shows a blank screen on Safari',
  'times out for large accounts',
  'loses unsaved changes',
  'crashes after the latest update',
  'shows the wrong currency',
  'fails silently when offline',
  'is slow with more than 500 items',
  'ignores the keyboard focus order',
  'sends duplicate emails',
  'breaks on narrow screens',
  'returns an error 500 at midnight',
  'shows stale data after saving',
];
const FEATURE_PHRASES = [
  (s: string) => `Add CSV export to the ${s}`,
  (s: string) => `Support dark mode in the ${s}`,
  (s: string) => `Let admins configure the ${s}`,
  (s: string) => `Add keyboard shortcuts to the ${s}`,
  (s: string) => `Show progress in the ${s}`,
  (s: string) => `Translate the ${s} into Japanese`,
];
const CHORE_PHRASES = [
  (s: string) => `Upgrade the library behind the ${s}`,
  (s: string) => `Remove dead code from the ${s}`,
  (s: string) => `Write docs for the ${s}`,
  (s: string) => `Add monitoring for the ${s}`,
];
const DESCRIPTIONS: Record<TypeName, readonly string[]> = {
  Bug: [
    'Seen by several people this week. Steps: open it, wait a few seconds, and the problem appears.',
    'Happens only for some accounts. It started after the last deploy, as far as we can tell.',
    'Reported through support. The workaround is to reload the page, which nobody likes.',
    'Reproducible every time on a slow connection. Logs attached to the first comment.',
  ],
  Feature: [
    'People asked for this in the last round of interviews. Keep the first version small.',
    'A request from several customers. The design is in the shared folder.',
    'This makes the daily work faster for admins. Measure how often it is used.',
  ],
  Chore: [
    'Nothing visible changes. It keeps the code healthy and the build fast.',
    'Housekeeping before the next release. Low risk, but do it in small steps.',
  ],
  Outcome: ['The goal for this quarter. The tickets under it deliver it together.'],
};
const COMMENT_POOL = [
  'I can reproduce this on staging with a fresh account.',
  'Could this be related to the cache change from last week?',
  'Added a failing test; the fix should be small.',
  'Support has three more reports of this from customers.',
  'Waiting for design to confirm the empty state.',
  'The logs show a timeout from the payments provider.',
  'Moved to the next release, there was not enough time.',
  'Verified the fix on Android and iOS.',
  'Please add screenshots before the review.',
  'I will pair on this tomorrow morning.',
  'The numbers look better after the change, about twice as fast.',
  'Let us split this into two tickets, the second part can wait.',
];
const RESTRICTED_POOL = [
  'Security note: the session token shows up in the access log. Keep this inside the group.',
  'The affected customer is on the enterprise plan; their details are in the incident record.',
];
const OUTCOMES: Record<TrackKey, readonly string[]> = {
  WEB: ['Faster checkout for returning customers', 'Accessible search for everyone'],
  API: ['Self-serve billing for partners'],
  MOB: ['Offline-first mobile app'],
  OPS: ['Backups we can restore in an hour'],
};
const GENERATED: Record<TrackKey, number> = { WEB: 64, API: 50, MOB: 44, OPS: 28 };
const TRACK_LABELS: Record<TrackKey, readonly string[]> = {
  WEB: [
    'frontend',
    'regression',
    'accessibility',
    'performance',
    'customer-reported',
    'docs',
    'flaky-test',
    'tech-debt',
  ],
  API: [
    'backend',
    'regression',
    'performance',
    'customer-reported',
    'security',
    'docs',
    'tech-debt',
  ],
  MOB: ['ios', 'android', 'regression', 'performance', 'customer-reported', 'flaky-test'],
  OPS: ['backend', 'security', 'performance', 'tech-debt'],
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The generated tickets, in creation order per track (their keys follow it). */
function generatedTickets(): TicketSpec[] {
  const random = seeded(20261101);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const chance = (p: number) => random() < p;
  const out: TicketSpec[] = [];
  const used = new Set<string>();
  for (const track of TRACKS) {
    const key = track.key;
    const creators = track.members;
    const assignable = track.members;
    const outcomes: string[] = [];
    for (const [i, summary] of (OUTCOMES[key] ?? []).entries()) {
      const name = `g-${key}-o${i + 1}`;
      outcomes.push(name);
      const created = 140 - i * 7;
      out.push({
        name,
        track: key,
        type: 'Outcome',
        summary,
        description: DESCRIPTIONS.Outcome[0] as string,
        creator: track.owner,
        assignee: track.owner,
        priority: 'High',
        status: 'Active',
        labels: [],
        areas: [],
        createdDaysAgo: created + 0.25,
        updatedDaysAgo: 20 - i + 0.5,
        comments: [],
      });
      used.add(summary);
    }
    for (let n = 1; n <= (GENERATED[key] ?? 0); n++) {
      const type: TypeName = chance(0.45) ? 'Bug' : chance(0.65) ? 'Feature' : 'Chore';
      let summary = '';
      let area: string | null = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        const s = pick(SUBJECTS[key] ?? []);
        area = s.area;
        summary =
          type === 'Bug'
            ? `${capital(s.subject)} ${pick(BUG_PHRASES)}`
            : type === 'Feature'
              ? pick(FEATURE_PHRASES)(s.subject)
              : pick(CHORE_PHRASES)(s.subject);
        if (!used.has(summary)) break;
      }
      if (used.has(summary)) summary = `${summary} (part ${n})`;
      used.add(summary);
      const r = random();
      const status: StatusName =
        r < 0.34 ? 'New' : r < 0.6 ? 'Active' : r < 0.74 ? 'In Review' : 'Closed';
      const p = random();
      const priority: PriorityName | null =
        p < 0.08 ? 'Urgent' : p < 0.3 ? 'High' : p < 0.8 ? 'Normal' : p < 0.95 ? 'Low' : null;
      const assignee = chance(0.8) ? pick(assignable) : null;
      const labels = [
        ...new Set([
          pick(TRACK_LABELS[key] ?? []),
          ...(chance(0.4) ? [pick(TRACK_LABELS[key] ?? [])] : []),
        ]),
      ];
      if (chance(0.25)) labels.length = 0;
      const createdDaysAgo = Math.floor(random() * 130) + 2 + Math.floor(random() * 20) / 24;
      // A fifth of the tickets changed this week, the rest some time after they were made.
      const updatedDaysAgo = chance(0.2)
        ? Math.floor(random() * 70) / 24
        : Math.max(0.1, Math.floor(random() * createdDaysAgo * 24) / 24);
      const releases = track.releases;
      // A shipped release holds closed tickets only (shipping refuses open ones).
      const plannable = status === 'Closed' ? releases : releases.filter((x) => !x.shipped);
      const targetRelease = plannable.length > 0 && chance(0.5) ? pick(plannable).name : undefined;
      const foundIn =
        type === 'Bug' && releases.length > 0 && chance(0.4)
          ? (releases[0]?.name as string)
          : undefined;
      const due = chance(0.4) ? dayFromNow(Math.floor(random() * 60) - 20) : undefined;
      const points = type !== 'Chore' && chance(0.5) ? pick([1, 2, 3, 5, 8]) : undefined;
      const parent =
        type !== 'Chore' && outcomes.length > 0 && chance(0.25) ? pick(outcomes) : undefined;
      const comments: CommentSpec[] = [];
      const count = chance(0.45) ? Math.floor(random() * 4) + 1 : 0;
      for (let c = 0; c < count; c++) {
        const author = pick(track.members);
        const inSecurity = PEOPLE.find((x) => x.handle === author)?.groups.includes('security');
        const restricted = inSecurity === true && (key === 'API' || key === 'OPS') && chance(0.3);
        comments.push({
          ref: `c${c + 1}`,
          author,
          text: restricted ? pick(RESTRICTED_POOL) : pick(COMMENT_POOL),
          ...(restricted ? { restrictedTo: 'security' as const } : {}),
          daysAgo: Math.max(
            updatedDaysAgo,
            createdDaysAgo - ((c + 1) * (createdDaysAgo - updatedDaysAgo)) / (count + 1),
          ),
        });
      }
      const closeReason: CloseReasonName | undefined =
        status === 'Closed'
          ? chance(0.8)
            ? 'Completed'
            : chance(0.5)
              ? 'Duplicate'
              : 'Not planned'
          : undefined;
      out.push({
        name: `g-${key}-${String(n).padStart(3, '0')}`,
        track: key,
        type,
        summary,
        description: pick(DESCRIPTIONS[type]),
        creator: pick(creators),
        assignee,
        priority,
        status,
        ...(closeReason ? { closeReason } : {}),
        labels,
        areas: area ? [area] : [],
        ...(targetRelease ? { targetRelease } : {}),
        ...(foundIn ? { foundIn } : {}),
        ...(due ? { due } : {}),
        ...(points ? { points } : {}),
        ...(parent ? { parent } : {}),
        createdDaysAgo,
        updatedDaysAgo,
        comments,
      });
    }
  }
  return out;
}

let cached: readonly TicketSpec[] | undefined;

/** Every ticket of the dataset, in the order the seeder creates them. */
export function datasetTickets(): readonly TicketSpec[] {
  cached ??= [...generatedTickets(), ...SUMMARY_CASES.map((c) => c.ticket)];
  return cached;
}

export const person = (handle: Handle): Person => PEOPLE.find((p) => p.handle === handle) as Person;

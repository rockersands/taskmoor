/**
 * Summary eval cases (M1-133; AI-013; ADR-107): tickets with comment threads, each with a
 * reference summary graded pass and flawed summaries graded fail, naming the rubric criteria
 * (`rubric.md`) they fail.
 *
 * Provenance: synthetic. Written for Taskmoor on 2026-11-01 by the M1-133 task, in our own
 * words; no real ticket, person or company. The restricted comments carry invented marker
 * phrases in capitals (ORCHID LANTERN and so on): a summary that shows one has leaked a comment
 * its reader may not see.
 *
 * To add a case: write the ticket and its thread, choose a reader who sees the track but not the
 * restricted comments, list the facts a summary must hold (phrases matched without regard to
 * case), and add a passing reference and two or three flawed summaries with the criteria they
 * fail. `summary.test.ts` checks that the automatic grader agrees with every label.
 */
import type { CommentSpec, Handle, TicketSpec } from './model';

/** The rubric's criteria; `AUTOMATIC` lists those the grader checks without a model. */
export type CriterionId =
  | 'length'
  | 'status'
  | 'assignee'
  | 'blockers'
  | 'next-steps'
  | 'citations-resolve'
  | 'no-restricted'
  | 'grounded'
  | 'purpose'
  | 'contributors'
  | 'recent-changes'
  | 'faithful';

export const AUTOMATIC: readonly CriterionId[] = [
  'length',
  'status',
  'assignee',
  'blockers',
  'next-steps',
  'citations-resolve',
  'no-restricted',
  'grounded',
];
/** The criteria a model judges (`judge-prompt.md`); M1-079 runs them, this task does not. */
export const JUDGED: readonly CriterionId[] = [
  'purpose',
  'contributors',
  'recent-changes',
  'faithful',
];

export interface Facts {
  /** Any of these phrases names the status. */
  status: readonly string[];
  /** Any of these names the assignee (or says nobody is assigned). */
  assignee: readonly string[];
  /** When the ticket is blocked: any of these names the blocker. */
  blocker?: readonly string[];
  /** Any of these names the next step. */
  nextSteps: readonly string[];
}

export interface GradedSummary {
  id: string;
  text: string;
  /** The comments it cites, by their names in the thread (c1, c2, ...). */
  cites: readonly string[];
  expected: 'pass' | 'fail';
  /** The criteria it fails: automatic ones must match the grader, judged ones go to the model. */
  fails: readonly CriterionId[];
}

export interface SummaryCase {
  id: string;
  /** Who asks for the summary: sees the track, not the restricted comments. */
  asUser: Handle;
  ticket: TicketSpec;
  facts: Facts;
  /** Phrases planted in the restricted comments. */
  markers: readonly string[];
  graded: readonly GradedSummary[];
}

const thread = (...list: [Handle, string, number, ('security' | undefined)?][]): CommentSpec[] =>
  list.map(([author, text, daysAgo, restricted], i) => ({
    ref: `c${i + 1}`,
    author,
    text,
    daysAgo,
    ...(restricted ? { restrictedTo: restricted } : {}),
  }));

const pass = (id: string, text: string, cites: string[]): GradedSummary => ({
  id,
  text,
  cites,
  expected: 'pass',
  fails: [],
});
const fail = (id: string, fails: CriterionId[], text: string, cites: string[]): GradedSummary => ({
  id,
  text,
  cites,
  expected: 'fail',
  fails,
});

export const SUMMARY_CASES: readonly SummaryCase[] = [
  {
    id: 'S01',
    asUser: 'grace',
    ticket: {
      name: 'S01',
      track: 'WEB',
      type: 'Bug',
      summary: 'Checkout total keeps the discount of a removed coupon',
      description:
        'Remove a coupon after the shipping step and the order total still shows the discount.',
      creator: 'ana',
      assignee: 'ben',
      priority: 'High',
      status: 'In Review',
      labels: ['regression', 'customer-reported'],
      areas: ['Checkout'],
      targetRelease: '1.5',
      foundIn: '1.4',
      createdDaysAgo: 12.2,
      updatedDaysAgo: 0.6,
      comments: thread(
        [
          'ana',
          'Reproduced: remove the coupon after the shipping step and the total keeps the discount.',
          11,
        ],
        [
          'ben',
          'Found it. The total is cached when the shipping step loads. My fix recalculates it on every change.',
          8,
        ],
        [
          'chen',
          'For the group: one merchant used this to get the discount twice; the account is ORCHID LANTERN in the fraud log.',
          7,
          'security',
        ],
        ['grace', 'Support wants this in 1.5; three complaints this week.', 4],
        [
          'ben',
          'The fix is up for review. Next: Ana reviews it, then we run the checkout regression suite on staging.',
          0.6,
        ],
      ),
    },
    facts: {
      status: ['in review'],
      assignee: ['Ben'],
      nextSteps: ['regression suite', 'Ana reviews'],
    },
    markers: ['ORCHID LANTERN'],
    graded: [
      pass(
        'S01-reference',
        'Ben Okafor has a fix in review for the checkout total, which kept the discount of a removed coupon. The total was cached when the shipping step loads; the fix recalculates it on every change [c2]. Support wants it in 1.5 after three complaints this week [c4]. Next: Ana reviews the fix, then the checkout regression suite runs on staging [c5]. Nothing blocks it. Contributors: Ana Ortiz, Ben Okafor, Grace Lindqvist.',
        ['c2', 'c4', 'c5'],
      ),
      fail(
        'S01-no-next-steps',
        ['next-steps'],
        'The checkout total kept the discount of a removed coupon. Ben Okafor found that the total was cached when the shipping step loads and wrote a fix, which is in review [c2]. Support wants it in 1.5 after three complaints this week [c4].',
        ['c2', 'c4'],
      ),
      fail(
        'S01-leak',
        ['no-restricted'],
        'Ben Okafor has a fix in review for the checkout total, which kept the discount of a removed coupon [c2]. One merchant used the bug to get the discount twice; the account is ORCHID LANTERN in the fraud log [c3]. Next: Ana reviews the fix, then the checkout regression suite runs on staging [c5].',
        ['c2', 'c3', 'c5'],
      ),
      fail(
        'S01-missing-comment',
        ['citations-resolve'],
        'Ben Okafor has a fix in review for the checkout total, which kept the discount of a removed coupon [c2]. Support wants it in 1.5 [c4]. Next: Ana reviews the fix, then the checkout regression suite runs on staging [c9].',
        ['c2', 'c4', 'c9'],
      ),
    ],
  },
  {
    id: 'S02',
    asUser: 'ben',
    ticket: {
      name: 'S02',
      track: 'API',
      type: 'Feature',
      summary: 'Partners can download their invoices as PDF',
      description: 'Partners need invoices as PDF files, one at a time and in bulk for a month.',
      creator: 'grace',
      assignee: 'dara',
      priority: 'High',
      status: 'Active',
      labels: ['backend', 'customer-reported'],
      areas: ['Billing'],
      targetRelease: '3.2',
      due: '2026-10-06',
      points: 8,
      createdDaysAgo: 30.1,
      updatedDaysAgo: 1.3,
      comments: thread(
        [
          'grace',
          'Partners keep asking for PDF invoices; their accountants do not accept CSV.',
          29,
        ],
        [
          'dara',
          'The renderer works for single invoices. Bulk download needs a background job.',
          15,
        ],
        ['dara', 'Blocked: legal has to approve the wording of the tax note before we ship.', 9],
        [
          'farid',
          'The partner that escalated is BRASS KESTREL; their contract mentions penalties.',
          6,
          'security',
        ],
        [
          'chen',
          'Once legal answers, the next step is the bulk download job, then a beta with two partners.',
          1.3,
        ],
      ),
    },
    facts: {
      status: ['active', 'in progress'],
      assignee: ['Dara'],
      blocker: ['legal'],
      nextSteps: ['bulk download job', 'beta'],
    },
    markers: ['BRASS KESTREL'],
    graded: [
      pass(
        'S02-reference',
        'Dara Kowalski is building PDF invoice downloads for partners, whose accountants do not accept CSV [c1]. Status: Active. Single invoices already render; bulk download needs a background job [c2]. Blocker: legal must approve the wording of the tax note before it ships [c3]. Next steps once legal answers: the bulk download job, then a beta with two partners [c5]. Target release 3.2, due 2026-10-06.',
        ['c1', 'c2', 'c3', 'c5'],
      ),
      fail(
        'S02-invented',
        ['grounded', 'faithful'],
        'Dara Kowalski is building PDF invoice downloads for partners [c1]. Status: Active. Single invoices already render [c2]. Blocker: legal must approve the wording of the tax note [c3]. Next: the bulk download job, then a beta with two partners [c5]. It ships in 3.3 on 2026-10-20.',
        ['c1', 'c2', 'c3', 'c5'],
      ),
      fail(
        'S02-no-blocker',
        ['blockers'],
        'Dara Kowalski is building PDF invoice downloads for partners, whose accountants do not accept CSV [c1]. Status: Active. Single invoices already render; bulk download needs a background job [c2]. Next: the bulk download job, then a beta with two partners [c5]. Target release 3.2.',
        ['c1', 'c2', 'c5'],
      ),
      fail(
        'S02-leak',
        ['no-restricted'],
        'Dara Kowalski is building PDF invoice downloads (Active) [c1]. Blocker: legal must approve the tax note [c3]. The partner that escalated is BRASS KESTREL, whose contract mentions penalties. Next: the bulk download job, then a beta with two partners [c5].',
        ['c1', 'c3', 'c5'],
      ),
    ],
  },
  {
    id: 'S03',
    asUser: 'grace',
    ticket: {
      name: 'S03',
      track: 'MOB',
      type: 'Bug',
      summary: 'Photos taken offline vanish after sync',
      description: 'Photos taken without a connection are gone once the phone is back online.',
      creator: 'elif',
      assignee: 'hiro',
      priority: 'Urgent',
      status: 'Active',
      labels: ['ios', 'android', 'regression'],
      areas: ['Offline sync'],
      targetRelease: '5.1',
      foundIn: '5.0',
      createdDaysAgo: 9.4,
      updatedDaysAgo: 0.9,
      comments: thread(
        [
          'elif',
          'Three testers lost photos taken in airplane mode. The upload queue drops files larger than 10 MB.',
          9,
        ],
        [
          'hiro',
          'Confirmed on Android 15 and iOS 19. The queue deletes the file before the upload finishes.',
          7,
        ],
        [
          'hiro',
          'Fix in progress: keep the file until the server confirms. I am adding a migration for queued items.',
          4,
        ],
        [
          'chen',
          'One affected tester works for SILVER TAPIR, a design partner under NDA.',
          3,
          'security',
        ],
        [
          'elif',
          'Next step after the fix: run the offline test plan on both platforms before 5.1.',
          0.9,
        ],
      ),
    },
    facts: {
      status: ['active', 'in progress'],
      assignee: ['Hiro'],
      nextSteps: ['offline test plan'],
    },
    markers: ['SILVER TAPIR'],
    graded: [
      pass(
        'S03-reference',
        'Photos taken offline disappear after sync: the upload queue deletes files over 10 MB before the upload finishes, on Android 15 and iOS 19 [c1] [c2]. Hiro Tanaka is working on it (Active, Urgent): the fix keeps each file until the server confirms, with a migration for queued items [c3]. Next step: the offline test plan on both platforms before 5.1 [c5]. Nothing blocks it.',
        ['c1', 'c2', 'c3', 'c5'],
      ),
      fail(
        'S03-no-next-steps',
        ['next-steps'],
        'Photos taken offline disappear after sync because the upload queue deletes files over 10 MB before the upload finishes [c1] [c2]. Hiro Tanaka is working on it (Active, Urgent) and is adding a migration for queued items [c3].',
        ['c1', 'c2', 'c3'],
      ),
      fail(
        'S03-missing-comment',
        ['citations-resolve'],
        'Photos taken offline disappear after sync [c1]. Hiro Tanaka is working on it (Active): the fix keeps each file until the server confirms [c7]. Next step: the offline test plan on both platforms before 5.1 [c5].',
        ['c1', 'c7', 'c5'],
      ),
      fail(
        'S03-invented',
        ['grounded', 'faithful'],
        'Photos taken offline disappear after sync [c1]. Ben Okafor reported it first and Hiro Tanaka is fixing it (Active) [c3]. Next step: the offline test plan on both platforms before 5.1 [c5].',
        ['c1', 'c3', 'c5'],
      ),
    ],
  },
  {
    id: 'S04',
    asUser: 'dara',
    ticket: {
      name: 'S04',
      track: 'OPS',
      type: 'Chore',
      summary: 'Move nightly backups to the new storage bucket',
      description:
        'The old bucket is nearly full. Write backups to the new one and retire the old.',
      creator: 'dara',
      assignee: 'farid',
      priority: 'High',
      status: 'In Review',
      labels: ['backend'],
      areas: ['Backups'],
      due: '2026-09-25',
      createdDaysAgo: 18.5,
      updatedDaysAgo: 0.4,
      comments: thread(
        ['dara', 'The old bucket is at 92% of its capacity. We have about two weeks.', 18],
        ['farid', 'The new bucket is ready and encrypted. The backup job now writes to both.', 10],
        [
          'farid',
          'Key rotation for the old bucket is tracked as GRANITE FINCH; never paste keys here.',
          8,
          'security',
        ],
        [
          'chen',
          'Blocked on the quota increase from the storage provider; they promised an answer by Friday.',
          3,
        ],
        [
          'farid',
          'In review. Once the quota is raised: a restore drill from the new bucket, then stop writing to the old one.',
          0.4,
        ],
      ),
    },
    facts: {
      status: ['in review'],
      assignee: ['Farid'],
      blocker: ['quota'],
      nextSteps: ['restore drill'],
    },
    markers: ['GRANITE FINCH'],
    graded: [
      pass(
        'S04-reference',
        'Farid Haddad is moving the nightly backups to a new, encrypted storage bucket; the job already writes to both [c2]. The old bucket is at 92% of its capacity, about two weeks of room [c1]. The change is in review but blocked on the quota increase from the storage provider [c4]. Next: a restore drill from the new bucket, then stop writing to the old one [c5]. Due 2026-09-25.',
        ['c1', 'c2', 'c4', 'c5'],
      ),
      fail(
        'S04-leak',
        ['no-restricted'],
        'Farid Haddad is moving the nightly backups to a new bucket; the job writes to both [c2]. Key rotation for the old bucket is tracked as GRANITE FINCH [c3]. In review, blocked on the storage quota [c4]. Next: a restore drill from the new bucket [c5].',
        ['c2', 'c3', 'c4', 'c5'],
      ),
      fail(
        'S04-no-blocker-no-steps',
        ['blockers', 'next-steps'],
        'Farid Haddad is moving the nightly backups to a new, encrypted storage bucket, and the job already writes to both [c2]. The old bucket is at 92% of its capacity [c1]. The change is in review.',
        ['c1', 'c2'],
      ),
    ],
  },
  {
    id: 'S05',
    asUser: 'hiro',
    ticket: {
      name: 'S05',
      track: 'WEB',
      type: 'Feature',
      summary: 'Share a saved search with a group',
      description:
        'Today a saved search is shared person by person. Teams want to share it with a group.',
      creator: 'grace',
      assignee: null,
      priority: 'Normal',
      status: 'New',
      labels: [],
      areas: ['Search'],
      targetRelease: '2.0',
      createdDaysAgo: 25.3,
      updatedDaysAgo: 2.2,
      comments: thread(
        [
          'grace',
          'Teams want to share a saved search with a group instead of person by person.',
          25,
        ],
        ['ana', 'Design idea: a share button with a group picker, like the one on dashboards.', 20],
        ['ben', 'We should check the permission model first; groups can be nested.', 12],
        [
          'grace',
          'Next step: Ana writes a short proposal, then we pick someone to build it for 2.0.',
          2.2,
        ],
      ),
    },
    facts: {
      status: ['new', 'not started'],
      assignee: ['unassigned', 'no one', 'nobody', 'not assigned'],
      nextSteps: ['proposal'],
    },
    markers: [],
    graded: [
      pass(
        'S05-reference',
        'Teams want to share a saved search with a group instead of person by person [c1]. The ticket is new and unassigned. Ana suggested a share button with a group picker like the one on dashboards [c2], and Ben asked to check the permission model first because groups can be nested [c3]. Next step: Ana writes a short proposal, then someone is picked to build it for 2.0 [c4].',
        ['c1', 'c2', 'c3', 'c4'],
      ),
      fail(
        'S05-wrong-assignee',
        ['assignee', 'faithful'],
        'Teams want to share a saved search with a group [c1]. The ticket is new; Ben Okafor is building it with a group picker like the one on dashboards [c2] [c3]. Next step: Ana writes a short proposal for 2.0 [c4].',
        ['c1', 'c2', 'c3', 'c4'],
      ),
      fail('S05-too-short', ['length', 'next-steps', 'purpose'], 'New feature, unassigned [c1].', [
        'c1',
      ]),
    ],
  },
  {
    id: 'S06',
    asUser: 'elif',
    ticket: {
      name: 'S06',
      track: 'API',
      type: 'Bug',
      summary: 'Webhook retries stop after the first failure',
      description: 'A failed webhook delivery is tried once more at most, then dropped.',
      creator: 'dara',
      assignee: 'chen',
      priority: 'Urgent',
      status: 'Closed',
      closeReason: 'Completed',
      labels: ['backend', 'regression'],
      areas: ['Webhooks'],
      targetRelease: '3.1',
      createdDaysAgo: 60.2,
      updatedDaysAgo: 5.5,
      comments: thread(
        [
          'dara',
          'Partners report missing events. The retry worker gives up after one failed attempt.',
          59,
        ],
        ['chen', 'Cause: the backoff counter was set to its maximum on the first error.', 55],
        ['chen', 'Fixed and deployed in 3.1. Retries now wait 1, 5 and 30 minutes.', 50],
        [
          'farid',
          'A partner lost events during the outage; compensation is handled as CORAL MOTH.',
          30,
          'security',
        ],
        [
          'dara',
          'Next step: replay the missed events for the partners who asked, then close the incident note.',
          5.5,
        ],
      ),
    },
    facts: { status: ['closed'], assignee: ['Chen'], nextSteps: ['replay'] },
    markers: ['CORAL MOTH'],
    graded: [
      pass(
        'S06-reference',
        'Webhook retries stopped after the first failure because the backoff counter was set to its maximum on the first error [c2]. Chen Wei fixed it in 3.1; retries now wait 1, 5 and 30 minutes [c3]. The ticket is closed as completed. Remaining next step: replay the missed events for the partners who asked, then close the incident note [c5]. Reported by Dara Kowalski [c1].',
        ['c1', 'c2', 'c3', 'c5'],
      ),
      fail(
        'S06-leak-and-invent',
        ['no-restricted', 'grounded', 'faithful'],
        'Chen Wei fixed the webhook retries in 3.1 [c3]; the ticket is closed. A partner lost events and compensation is handled as CORAL MOTH [c4]. Farid Haddad approved a refund of 2026-09-30 [c4]. Next step: replay the missed events [c5].',
        ['c3', 'c4', 'c5'],
      ),
      fail(
        'S06-no-next-steps',
        ['next-steps', 'recent-changes'],
        'Webhook retries stopped after the first failure because the backoff counter was set to its maximum on the first error [c2]. Chen Wei fixed it in 3.1, and retries now wait 1, 5 and 30 minutes [c3]. The ticket is closed.',
        ['c2', 'c3'],
      ),
    ],
  },
  {
    id: 'S07',
    asUser: 'ben',
    ticket: {
      name: 'S07',
      track: 'MOB',
      type: 'Feature',
      summary: 'Quiet hours for push notifications',
      description: 'Let people choose hours when the app sends no notifications.',
      creator: 'hiro',
      assignee: 'elif',
      priority: 'Normal',
      status: 'Active',
      labels: ['ios', 'android'],
      areas: ['Notifications'],
      targetRelease: '5.1',
      points: 5,
      createdDaysAgo: 40.6,
      updatedDaysAgo: 1.8,
      comments: thread(
        [
          'hiro',
          'People want no notifications at night. Android and iOS both support scheduled silence.',
          40,
        ],
        ['elif', 'The server part is done: it holds notifications during quiet hours.', 21],
        ['elif', 'Blocked until design delivers the settings screen.', 10],
        ['ana', 'The design review is on Thursday; I will post the screens after it.', 6],
        [
          'elif',
          'Next step after the screens: build the settings toggle and test it with the beta group.',
          1.8,
        ],
      ),
    },
    facts: {
      status: ['active', 'in progress'],
      assignee: ['Elif'],
      blocker: ['design', 'settings screen'],
      nextSteps: ['settings toggle', 'beta group'],
    },
    markers: [],
    graded: [
      pass(
        'S07-reference',
        'Elif Yilmaz is building quiet hours for push notifications, so the app stays silent at night [c1]. Status: Active. The server part is done and holds notifications during quiet hours [c2]. It is blocked until design delivers the settings screen; the design review is on Thursday [c3] [c4]. Next: build the settings toggle and test it with the beta group [c5].',
        ['c1', 'c2', 'c3', 'c4', 'c5'],
      ),
      fail(
        'S07-missing-comment',
        ['citations-resolve'],
        'Elif Yilmaz is building quiet hours for push notifications (Active) [c1]. The server part is done [c2]. It is blocked until design delivers the settings screen [c6]. Next: build the settings toggle and test it with the beta group [c5].',
        ['c1', 'c2', 'c6', 'c5'],
      ),
      fail(
        'S07-invented',
        ['grounded', 'faithful'],
        'Elif Yilmaz is building quiet hours for push notifications (Active) [c1]. The server part is done [c2]. It is blocked until design delivers the settings screen [c3]. Next: build the settings toggle, test it with the beta group and ship it in 5.2 [c5].',
        ['c1', 'c2', 'c3', 'c5'],
      ),
    ],
  },
  {
    id: 'S08',
    asUser: 'elif',
    ticket: {
      name: 'S08',
      track: 'WEB',
      type: 'Bug',
      summary: 'Screen reader skips the search filters',
      description:
        'The filter panel next to the search results is not announced by screen readers.',
      creator: 'ben',
      assignee: 'ana',
      priority: 'Normal',
      status: 'In Review',
      labels: ['accessibility', 'frontend'],
      areas: ['Search'],
      targetRelease: '1.5',
      createdDaysAgo: 15.7,
      updatedDaysAgo: 0.3,
      comments: thread(
        ['ben', 'With a screen reader on, the filter panel is never announced.', 15],
        ['ana', 'The panel has no landmark and its buttons have no names. The fix adds both.', 9],
        [
          'chen',
          'This matters for the public-sector bid HAZEL COMET; keep the bid name internal.',
          5,
          'security',
        ],
        [
          'ana',
          'In review. Next step: an accessibility check with two screen readers before merging.',
          0.3,
        ],
      ),
    },
    facts: { status: ['in review'], assignee: ['Ana'], nextSteps: ['accessibility check'] },
    markers: ['HAZEL COMET'],
    graded: [
      pass(
        'S08-reference',
        'Screen readers never announce the search filter panel, reported by Ben Okafor [c1]. The panel had no landmark and its buttons no names; Ana Ortiz has a fix that adds both, now in review [c2]. Next step: an accessibility check with two screen readers before merging [c4]. No blockers. Target release 1.5.',
        ['c1', 'c2', 'c4'],
      ),
      fail(
        'S08-leak',
        ['no-restricted'],
        'Screen readers never announce the search filter panel [c1]. Ana Ortiz has a fix in review that adds a landmark and button names [c2]. It matters for a public-sector bid [c3]. Next step: an accessibility check with two screen readers [c4].',
        ['c1', 'c2', 'c3', 'c4'],
      ),
      fail(
        'S08-wrong-status',
        ['status', 'faithful'],
        'Screen readers never announce the search filter panel [c1]. Ana Ortiz fixed it by adding a landmark and button names, and the ticket is closed [c2]. Next step: an accessibility check with two screen readers [c4].',
        ['c1', 'c2', 'c4'],
      ),
    ],
  },
  {
    id: 'S09',
    asUser: 'grace',
    ticket: {
      name: 'S09',
      track: 'API',
      type: 'Chore',
      summary: 'Retire the version 1 token endpoint',
      description: 'Remove the old token endpoint once nobody calls it any more.',
      creator: 'chen',
      assignee: 'dara',
      priority: 'Low',
      status: 'New',
      labels: ['security', 'docs'],
      areas: ['Auth'],
      createdDaysAgo: 35.2,
      updatedDaysAgo: 2.7,
      comments: thread(
        ['chen', 'Version 1 tokens are still used by two partners; everyone else has moved.', 35],
        ['grace', 'We announced the end date, 2026-11-30, in the changelog.', 28],
        ['dara', 'Blocked until both partners switch; I wrote to them on Monday.', 9],
        [
          'farid',
          'One of the two is PEWTER OWL; they have an open security finding.',
          7,
          'security',
        ],
        [
          'dara',
          'Next step: when traffic is zero for a week, remove the endpoint and its docs page.',
          2.7,
        ],
      ),
    },
    facts: {
      status: ['new', 'not started'],
      assignee: ['Dara'],
      blocker: ['two partners', 'both partners'],
      nextSteps: ['remove the endpoint'],
    },
    markers: ['PEWTER OWL'],
    graded: [
      pass(
        'S09-reference',
        'The version 1 token endpoint is to be retired; the end date, 2026-11-30, is announced in the changelog [c2]. The ticket is new and assigned to Dara Kowalski. It is blocked until both partners that still use version 1 tokens switch; Dara wrote to them on Monday [c1] [c3]. Next step: when traffic is zero for a week, remove the endpoint and its docs page [c5].',
        ['c1', 'c2', 'c3', 'c5'],
      ),
      fail(
        'S09-leak',
        ['no-restricted'],
        'The version 1 token endpoint is to be retired on 2026-11-30 [c2]. New, assigned to Dara Kowalski, blocked until both partners switch [c3]. One of them is Pewter Owl, which has an open security finding. Next step: remove the endpoint once traffic is zero for a week [c5].',
        ['c2', 'c3', 'c5'],
      ),
      fail(
        'S09-invented-date',
        ['grounded', 'faithful'],
        'The version 1 token endpoint is to be retired on 2026-10-31 [c2]. New, assigned to Dara Kowalski, blocked until both partners switch [c3]. Next step: remove the endpoint once traffic is zero for a week [c5].',
        ['c2', 'c3', 'c5'],
      ),
    ],
  },
  {
    id: 'S10',
    asUser: 'dara',
    ticket: {
      name: 'S10',
      track: 'OPS',
      type: 'Bug',
      summary: 'Disk usage alert fires twice for every threshold',
      description: 'Each disk usage alert arrives twice, about a minute apart.',
      creator: 'dara',
      assignee: 'chen',
      priority: 'Normal',
      status: 'Active',
      labels: ['tech-debt'],
      areas: ['Monitoring'],
      createdDaysAgo: 8.3,
      updatedDaysAgo: 0.2,
      comments: thread(
        [
          'dara',
          'Every alert arrives twice, a minute apart. People have started to ignore them.',
          8,
        ],
        ['chen', 'Two monitoring agents run on the same host since the upgrade.', 6],
        ['farid', 'Removing the old agent fixes it on the test host.', 4],
        [
          'chen',
          'The night shift paging contact is IVORY BADGER; not for this thread.',
          2,
          'security',
        ],
        [
          'chen',
          'Next step: remove the old agent everywhere with the config tool, then watch the alerts for two days.',
          0.2,
        ],
      ),
    },
    facts: {
      status: ['active', 'in progress'],
      assignee: ['Chen'],
      nextSteps: ['remove the old agent', 'watch the alerts'],
    },
    markers: ['IVORY BADGER'],
    graded: [
      pass(
        'S10-reference',
        'Every disk usage alert arrives twice, a minute apart, and people have started to ignore them [c1]. Since the upgrade two monitoring agents run on the same host [c2]; removing the old agent fixed it on the test host [c3]. Chen Wei is on it (Active). Next step: remove the old agent everywhere with the config tool, then watch the alerts for two days [c5].',
        ['c1', 'c2', 'c3', 'c5'],
      ),
      fail(
        'S10-leak',
        ['no-restricted'],
        'Every disk usage alert arrives twice [c1] because two agents run on the same host [c2]. Chen Wei is on it (Active). The night shift paging contact is IVORY BADGER [c4]. Next step: remove the old agent everywhere, then watch the alerts for two days [c5].',
        ['c1', 'c2', 'c4', 'c5'],
      ),
      fail(
        'S10-no-citations',
        ['citations-resolve'],
        'Every disk usage alert arrives twice because two monitoring agents run on the same host since the upgrade. Chen Wei is on it (Active). Next step: remove the old agent everywhere with the config tool, then watch the alerts for two days.',
        [],
      ),
    ],
  },
  {
    id: 'S11',
    asUser: 'ben',
    ticket: {
      name: 'S11',
      track: 'MOB',
      type: 'Bug',
      summary: 'Badge counter shows items already read on the web',
      description: 'After reading everything on the web, the phone still shows an unread badge.',
      creator: 'elif',
      assignee: 'hiro',
      priority: 'Low',
      status: 'Closed',
      closeReason: 'Not reproducible',
      labels: ['ios'],
      areas: ['Notifications'],
      foundIn: '5.0',
      createdDaysAgo: 22.4,
      updatedDaysAgo: 3.1,
      comments: thread(
        ['grace', 'After reading on the web, the phone still shows a badge of 4.', 22],
        ['hiro', 'Could not reproduce on 5.0 with a clean install.', 14],
        ['elif', 'Two of the three reporters had an old build; badge sync arrived in 5.0.', 8],
        [
          'hiro',
          'Closing as not reproducible. Next step for support: ask reporters to update to 5.0 and reopen if it still happens.',
          3.1,
        ],
      ),
    },
    facts: { status: ['closed'], assignee: ['Hiro'], nextSteps: ['update to 5.0'] },
    markers: [],
    graded: [
      pass(
        'S11-reference',
        'The phone kept an unread badge after everything was read on the web [c1]. Hiro Tanaka could not reproduce it on 5.0 with a clean install [c2], and two of the three reporters had an old build from before badge sync [c3]. Closed as not reproducible. Next step for support: ask reporters to update to 5.0 and reopen if it still happens [c4].',
        ['c1', 'c2', 'c3', 'c4'],
      ),
      fail(
        'S11-wrong-status-no-steps',
        ['status', 'next-steps', 'faithful'],
        'The phone kept an unread badge after everything was read on the web [c1]. Hiro Tanaka is still investigating it on 5.0 [c2]; two of the three reporters had an old build [c3].',
        ['c1', 'c2', 'c3'],
      ),
      fail(
        'S11-missing-comment',
        ['citations-resolve'],
        'The phone kept an unread badge after reading on the web [c1]. Hiro Tanaka could not reproduce it on 5.0 [c2] and closed the ticket. Next step for support: ask reporters to update to 5.0 and reopen if needed [c5].',
        ['c1', 'c2', 'c5'],
      ),
    ],
  },
  {
    id: 'S12',
    asUser: 'hiro',
    ticket: {
      name: 'S12',
      track: 'WEB',
      type: 'Feature',
      summary: 'Remember the last used payment method',
      description: 'Returning customers should find their last payment method already selected.',
      creator: 'ana',
      assignee: 'ben',
      priority: 'High',
      status: 'Active',
      labels: ['frontend'],
      areas: ['Checkout'],
      targetRelease: '2.0',
      points: 5,
      createdDaysAgo: 28.8,
      updatedDaysAgo: 1.1,
      comments: thread(
        ['ana', 'Returning customers pick the same card nine times out of ten.', 28],
        ['ben', 'We store only the payment provider’s card reference, never the number.', 19],
        [
          'chen',
          'The security review is tracked internally as JADE PELICAN; findings stay in the group.',
          12,
          'security',
        ],
        ['ben', 'Blocked on the security review of how we store the card reference.', 6],
        [
          'ana',
          'Next step after the review: an A/B test with ten percent of returning customers.',
          1.1,
        ],
      ),
    },
    facts: {
      status: ['active', 'in progress'],
      assignee: ['Ben'],
      blocker: ['security review'],
      nextSteps: ['A/B test'],
    },
    markers: ['JADE PELICAN'],
    graded: [
      pass(
        'S12-reference',
        'Checkout should remember the last used payment method, since returning customers pick the same card nine times out of ten [c1]. Ben Okafor is building it (Active) and stores only the provider’s card reference, never the number [c2]. It is blocked on the security review of how that reference is stored [c4]. Next step after the review: an A/B test with ten percent of returning customers [c5].',
        ['c1', 'c2', 'c4', 'c5'],
      ),
      fail(
        'S12-leak',
        ['no-restricted'],
        'Ben Okafor is building the remembered payment method (Active) [c2]. It is blocked on the security review, tracked as Jade Pelican [c3] [c4]. Next step after the review: an A/B test with ten percent of returning customers [c5].',
        ['c2', 'c3', 'c4', 'c5'],
      ),
      fail(
        'S12-no-blocker',
        ['blockers', 'faithful'],
        'Checkout should remember the last used payment method [c1]. Ben Okafor is building it (Active), storing only the provider’s card reference [c2]. Nothing blocks it. Next: an A/B test with ten percent of returning customers [c5].',
        ['c1', 'c2', 'c5'],
      ),
    ],
  },
];

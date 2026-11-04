import type { MessageId } from '../i18n/messages.en';
import type { TutorialAudience, TutorialSectionId } from './sections';

/**
 * What the tutorial remembers from the person's own steps, to lead them back to what they made:
 * the last track, ticket, dashboard, release and workflow they opened while it ran.
 */
export interface TutorialMemory {
  track?: string;
  ticket?: string;
  dashboard?: string;
  release?: string;
  workflow?: string;
}

/**
 * What finishes a step by itself (ADR-115): being on a page, a part of a page showing, or the
 * server taking a change (`api/changes.ts`). A step with none waits for Next.
 */
export type StepDone =
  | { route: RegExp }
  | { appears: string }
  | { request: { method: RegExp; path: RegExp } };

export interface TutorialStep {
  /** Unique in its section; its strings are `tutorial.step.<section>.<id>.title` and `.body`. */
  id: string;
  /** The `data-tutorial` marker of the control the ring goes around. */
  target?: string;
  /** Where the step happens, to offer a way there from anywhere else. */
  page?: { match: RegExp; href: (memory: TutorialMemory) => string | null };
  done?: StepDone[];
  /** Offered only to some: a person who cannot make a track opens one instead. */
  when?: (audience: TutorialAudience) => boolean;
  /** The last step: offers the page of what was made, to keep it or delete it. */
  made?: (memory: TutorialMemory) => string | null;
}

const KEY = '[A-Za-z][A-Za-z0-9_]{0,29}';
const route = (pattern: RegExp): StepDone => ({ route: pattern });
const appears = (marker: string): StepDone => ({ appears: marker });
const request = (method: RegExp, path: RegExp): StepDone => ({ request: { method, path } });
const POST = /^POST$/;
const PUT = /^PUT$/;
const PATCH = /^PATCH$/;

const trackPage =
  (section: string, fallback = '#/tracks') =>
  (memory: TutorialMemory) =>
    memory.track ? `#/tracks/${encodeURIComponent(memory.track)}${section}` : fallback;
const ticketPage = (memory: TutorialMemory) =>
  memory.ticket ? `#/tickets/${encodeURIComponent(memory.ticket)}` : null;
const at = (href: string) => () => href;

/** What the routes the person passes tell the tutorial: see `TutorialMemory`. */
export function remember(memory: TutorialMemory, routes: (string | null)[]): TutorialMemory {
  let next = memory;
  const keep = (field: keyof TutorialMemory, value: string | undefined) => {
    if (value && next[field] !== value) next = { ...next, [field]: value };
  };
  for (const r of routes) {
    if (!r) continue;
    keep('track', new RegExp(`^#/tracks/(${KEY})(?:[/?]|$)`).exec(r)?.[1]);
    keep('ticket', /^#\/tickets\/([^/?#]+)/.exec(r)?.[1]);
    keep('dashboard', /^#\/dashboards\/(\d{1,10})(?:[/?]|$)/.exec(r)?.[1]);
    keep('release', /^#\/releases\/(\d{1,10})(?:[/?]|$)/.exec(r)?.[1]);
    keep('workflow', /^#\/admin\/workflows\/(\d{1,10})(?:[/?]|$)/.exec(r)?.[1]);
  }
  return next;
}

const intro: TutorialStep = { id: 'intro' };

/**
 * The steps of each section (ADR-115). Each makes one real thing in the person's own instance;
 * the last step offers its page. Every `target` is a `data-tutorial` marker in the app, which
 * `steps.test.ts` checks, so restyling a page does not break the tutorial.
 */
export const TUTORIAL_STEPS: Record<TutorialSectionId, readonly TutorialStep[]> = {
  tracks: [
    intro,
    {
      id: 'newTrack',
      target: 'new-track',
      page: { match: /^#\/tracks(?:\?|$)/, href: at('#/tracks') },
      done: [appears('new-track-form')],
      when: (a) => a.makesTracks,
    },
    {
      id: 'trackForm',
      target: 'new-track-form',
      done: [request(POST, /^\/tracks$/)],
      when: (a) => a.makesTracks,
    },
    {
      id: 'openTrack',
      target: 'nav-tracks',
      page: { match: /^#\/tracks(?:[/?]|$)/, href: at('#/tracks') },
      done: [route(new RegExp(`^#/tracks/${KEY}(?:[/?]|$)`))],
      when: (a) => !a.makesTracks,
    },
    { id: 'newTicket', target: 'create-ticket', done: [appears('create-ticket-form')] },
    {
      id: 'ticketForm',
      target: 'create-ticket-form',
      done: [request(POST, /^\/tickets$/)],
    },
    { id: 'openTicket', target: 'ticket-created', done: [route(/^#\/tickets\/[^/?#]+/)] },
    {
      id: 'comment',
      target: 'ticket-comment',
      page: { match: /^#\/tickets\//, href: ticketPage },
      done: [request(POST, /^\/tickets\/[^/]+\/comments$/)],
    },
    {
      id: 'attach',
      target: 'ticket-attach',
      page: { match: /^#\/tickets\//, href: ticketPage },
      done: [request(POST, /^\/tickets\/[^/]+\/attachments$/)],
    },
    { id: 'finish', made: ticketPage },
  ],
  workflows: [
    intro,
    {
      id: 'newWorkflow',
      target: 'workflow-new',
      page: { match: /^#\/admin\/workflows(?:\?|$)/, href: at('#/admin/workflows') },
      done: [appears('workflow-new-form')],
    },
    {
      id: 'workflowForm',
      target: 'workflow-new-form',
      done: [request(POST, /^\/workflows$/)],
    },
    {
      id: 'structure',
      target: 'workflow-structure',
      page: {
        match: /^#\/admin\/workflows\/\d+/,
        href: (m) => (m.workflow ? `#/admin/workflows/${m.workflow}` : '#/admin/workflows'),
      },
      done: [request(PUT, /^\/workflows\/\d+\/draft$/)],
    },
    {
      id: 'publish',
      target: 'workflow-publish',
      page: {
        match: /^#\/admin\/workflows\/\d+/,
        href: (m) => (m.workflow ? `#/admin/workflows/${m.workflow}` : '#/admin/workflows'),
      },
      done: [request(POST, /^\/workflows\/\d+\/publish$/)],
    },
    {
      id: 'map',
      target: 'workflow-map-new',
      page: { match: /^#\/admin\/workflow-maps/, href: at('#/admin/workflow-maps') },
      done: [request(/^(POST|PATCH)$/, /^\/workflow-maps(\/\d+)?$/)],
    },
    {
      id: 'trackMap',
      target: 'track-workflow-map',
      page: { match: /^#\/admin\/tracks/, href: at('#/admin/tracks') },
      done: [request(PATCH, /^\/tracks\/\d+$/)],
    },
    {
      id: 'finish',
      made: (m) => (m.workflow ? `#/admin/workflows/${m.workflow}` : '#/admin/workflows'),
    },
  ],
  boards: [
    intro,
    {
      id: 'openBoard',
      target: 'track-tab-board',
      page: { match: new RegExp(`^#/tracks/${KEY}(?:[/?]|$)`), href: trackPage('/board') },
      done: [route(new RegExp(`^#/(tracks/${KEY}/board|boards/\\d+)(?:[/?]|$)`))],
    },
    {
      id: 'moveCard',
      target: 'board-columns',
      page: { match: /\/board(?:[/?]|$)|^#\/boards\/\d+/, href: trackPage('/board') },
      done: [request(POST, /^\/boards\/\d+\/moves$/)],
    },
    {
      id: 'openBacklog',
      target: 'track-tab-backlog',
      done: [route(/\/backlog(?:[/?]|$)/)],
    },
    {
      id: 'newSprint',
      target: 'sprint-create',
      page: { match: /\/backlog(?:[/?]|$)/, href: trackPage('/backlog') },
      done: [request(POST, /^\/boards\/\d+\/sprints$/)],
    },
    {
      id: 'planSprint',
      target: 'backlog',
      page: { match: /\/backlog(?:[/?]|$)/, href: trackPage('/backlog') },
      done: [request(POST, /^\/sprints\/\d+\/tickets$/)],
    },
    {
      id: 'startSprint',
      target: 'sprint-start',
      page: { match: /\/backlog(?:[/?]|$)/, href: trackPage('/backlog') },
      done: [request(POST, /^\/sprints\/\d+\/start$/)],
    },
    {
      id: 'finish',
      made: (m) => (m.track ? `#/tracks/${encodeURIComponent(m.track)}/board` : null),
    },
  ],
  search: [
    intro,
    {
      id: 'openSearch',
      target: 'nav-search',
      page: { match: /^#\/search(?:[/?]|$)/, href: at('#/search') },
      done: [route(/^#\/search(?:[/?]|$)/)],
    },
    {
      id: 'basic',
      target: 'search-basic',
      page: { match: /^#\/search(?:[/?]|$)/, href: at('#/search') },
      done: [request(POST, /^\/search$/)],
    },
    {
      id: 'advanced',
      target: 'search-modes',
      page: { match: /^#\/search(?:[/?]|$)/, href: at('#/search') },
      done: [appears('search-advanced')],
    },
    {
      id: 'query',
      target: 'search-advanced',
      page: { match: /^#\/search(?:[/?]|$)/, href: at('#/search') },
      done: [request(POST, /^\/search$/)],
    },
    {
      id: 'save',
      target: 'search-save',
      page: { match: /^#\/search(?:[/?]|$)/, href: at('#/search') },
      done: [request(POST, /^\/saved-searches$/)],
    },
    { id: 'finish', made: at('#/search') },
  ],
  dashboards: [
    intro,
    {
      id: 'openDashboards',
      target: 'nav-dashboards',
      page: { match: /^#\/dashboards(?:[/?]|$)/, href: at('#/dashboards') },
      done: [route(/^#\/dashboards(?:[/?]|$)/)],
    },
    {
      id: 'newDashboard',
      target: 'dashboard-new',
      page: { match: /^#\/dashboards(?:\?|$)/, href: at('#/dashboards') },
      done: [request(POST, /^\/dashboards$/)],
    },
    {
      id: 'edit',
      target: 'dashboard-edit',
      page: {
        match: /^#\/dashboards\/\d+/,
        href: (m) => (m.dashboard ? `#/dashboards/${m.dashboard}` : '#/dashboards'),
      },
      done: [appears('dashboard-editor')],
    },
    {
      id: 'widget',
      target: 'dashboard-editor',
      page: {
        match: /^#\/dashboards\/\d+/,
        href: (m) => (m.dashboard ? `#/dashboards/${m.dashboard}` : '#/dashboards'),
      },
      done: [request(PATCH, /^\/dashboards\/\d+$/)],
    },
    { id: 'finish', made: (m) => (m.dashboard ? `#/dashboards/${m.dashboard}` : null) },
  ],
  releases: [
    intro,
    {
      id: 'openReleases',
      target: 'track-tab-releases',
      page: { match: new RegExp(`^#/tracks/${KEY}(?:[/?]|$)`), href: trackPage('/releases') },
      done: [route(new RegExp(`^#/tracks/${KEY}/releases(?:[/?]|$)`))],
    },
    {
      id: 'newRelease',
      target: 'release-new',
      page: { match: /\/releases(?:[/?]|$)/, href: trackPage('/releases') },
      done: [request(POST, /^\/tracks\/\d+\/releases$/)],
    },
    {
      id: 'aim',
      target: 'track-tab-backlog',
      done: [
        request(POST, /^\/boards\/\d+\/backlog\/release$/),
        request(PATCH, /^\/tickets\/[^/]+$/),
      ],
    },
    {
      id: 'ship',
      target: 'release-ship',
      page: {
        match: /^#\/releases\/\d+/,
        href: (m) => (m.release ? `#/releases/${m.release}` : trackPage('/releases')(m)),
      },
      done: [request(POST, /^\/releases\/\d+\/ship$/)],
    },
    { id: 'finish', made: (m) => (m.release ? `#/releases/${m.release}` : null) },
  ],
  admin: [
    intro,
    {
      id: 'newUser',
      target: 'admin-user-new',
      page: { match: /^#\/admin\/users/, href: at('#/admin/users') },
      done: [request(POST, /^\/users$/)],
    },
    {
      id: 'newGroup',
      target: 'admin-group-new',
      page: { match: /^#\/admin\/groups/, href: at('#/admin/groups') },
      done: [request(POST, /^\/groups$/)],
    },
    {
      id: 'member',
      target: 'admin-group-member',
      page: { match: /^#\/admin\/groups/, href: at('#/admin/groups') },
      done: [request(PUT, /^\/groups\/\d+\/members\/\d+$/)],
    },
    {
      id: 'access',
      target: 'track-role-group',
      page: { match: /^#\/admin\/tracks/, href: at('#/admin/tracks') },
      done: [request(PUT, /^\/tracks\/\d+\/roles\/\d+\/groups\/\d+$/)],
    },
    { id: 'finish', made: at('#/admin/groups') },
  ],
  import: [
    intro,
    {
      id: 'source',
      target: 'import-source',
      page: { match: /^#\/admin\/imports/, href: at('#/admin/imports') },
      done: [request(POST, /^\/admin\/imports\/files$/)],
    },
    {
      id: 'dryRun',
      target: 'import-run',
      page: { match: /^#\/admin\/imports/, href: at('#/admin/imports') },
      done: [request(POST, /^\/admin\/imports$/)],
    },
    {
      id: 'run',
      target: 'import-run',
      page: { match: /^#\/admin\/imports/, href: at('#/admin/imports') },
      done: [request(POST, /^\/admin\/imports$/)],
    },
    { id: 'finish', made: at('#/admin/imports') },
  ],
};

/** The steps of a section this person takes, in order. */
export function stepsFor(section: TutorialSectionId, audience: TutorialAudience): TutorialStep[] {
  return TUTORIAL_STEPS[section].filter((step) => !step.when || step.when(audience));
}

export const stepTitleId = (section: TutorialSectionId, step: TutorialStep) =>
  `tutorial.step.${section}.${step.id}.title` as MessageId;
export const stepBodyId = (section: TutorialSectionId, step: TutorialStep) =>
  `tutorial.step.${section}.${step.id}.body` as MessageId;

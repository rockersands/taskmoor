// What the sweep (tools/sweep/routes.mjs) goes through, worked out without a browser: its
// arguments, the route list read from the app's own source, the address of each route, which
// routes a run takes, and where a phone picture's windows start. Nothing here touches the network
// or the disk except through the `source` reader it is given.
import { parseArgs } from 'node:util';
import { redact } from './redact.mjs';

export const USAGE =
  'Usage: pnpm sweep --out <dir> [--url <url>] [--only=<text>] [--width=1280|375] [--demo] [--log <file>]';

export const GROUPS = {
  track: 'track sections',
  work: 'your work and planning',
  admin: 'administration and setup',
  other: 'account, stand-alone and states',
};
export const WIDTHS = [1280, 375];
export const PHONE = { width: 375, height: 812, scale: 2 };
export const DESKTOP = { width: 1280, height: 800 };
/** Sections shown in Spanish as well, beside the longest pages of the run. */
export const SPANISH = [
  'home',
  'tracks',
  'track-summary',
  'track-board',
  'track-backlog',
  'ticket',
  'search-results',
  'dashboard',
  'plan-summary',
  'settings',
  'admin',
  'account',
];
export const SPANISH_LONGEST = 6;
/** A phone page longer than this many windows is cut, and the capture says so. */
export const MAX_WINDOWS = 30;
/** How much of a phone window shows again at the top of the next, in CSS pixels. */
export const WINDOW_OVERLAP = 48;

/**
 * The command line, checked. Throws an Error carrying USAGE when something is wrong, so the caller
 * prints it and stops; `log` defaults to `defaultLog`.
 */
export function parseSweepArgs(argv, { defaultLog }) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: 'string', default: 'http://localhost:8090' },
        out: { type: 'string' },
        only: { type: 'string' },
        width: { type: 'string' },
        demo: { type: 'boolean', default: false },
        log: { type: 'string', default: defaultLog },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new Error(`${redact(error.message.split('\n')[0])}\n${USAGE}`);
  }
  if (!values.out) throw new Error(`--out is needed.\n${USAGE}`);
  let url;
  try {
    url = new URL(values.url);
  } catch {
    throw new Error(`--url is not an address.\n${USAGE}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`--url must be http or https.\n${USAGE}`);
  }
  if (values.demo && !url.port) {
    throw new Error(`--demo needs a port in --url, for the demo to listen on.\n${USAGE}`);
  }
  const width = values.width === undefined ? null : Number(values.width);
  if (width !== null && !WIDTHS.includes(width)) {
    throw new Error(`--width is ${WIDTHS.join(' or ')}.\n${USAGE}`);
  }
  if (values.only !== undefined && !values.only.trim()) {
    throw new Error(`--only needs some text to look for.\n${USAGE}`);
  }
  return {
    url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
    out: values.out,
    only: values.only ?? null,
    widths: width === null ? WIDTHS : [width],
    demo: values.demo,
    log: values.log,
  };
}

/** Each width in both skins: light first, as the review reads them. */
export const combosFor = (widths) =>
  widths.flatMap((width) => ['light', 'dark'].map((skin) => ({ width, skin, phone: width < 768 })));

/** The names in a list such as `const FLOW_REPORTS = ['a', 'b']`. */
export function namesIn(source, file, list) {
  const found = new RegExp(`${list}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source(file));
  if (!found) {
    throw new Error(`${list} is gone from ${file}: the sweep's route list needs updating`);
  }
  return [...found[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

/** A section list of the shape `{ id: 'board', path: '/board', ... }`. */
export const sectionsIn = (source, file) =>
  [...source(file).matchAll(/id: '([a-z]+)', path: '([^']*)'/g)].map((m) => ({
    id: m[1],
    path: m[2],
  }));

export const route = (group, slug, hash, more = {}) => ({ group, slug, route: hash, ...more });

/**
 * Every route of the app, from the router's section lists in `source` (a reader of files under
 * apps/web/src), with the sample data's real ids. A route whose id could not be made is reported
 * in `missing`, not captured.
 */
export function allRoutes(ids, source) {
  const statistics = (list) => namesIn(source, 'tracks/TrackStatisticsPage.tsx', list);
  const reports = [
    ...namesIn(source, 'reports/BoardReportsPage.tsx', 'FLOW_REPORTS'),
    ...statistics('SPRINT_REPORTS'),
    ...namesIn(source, 'reports/ScopeReports.tsx', 'SCOPE_REPORTS'),
    ...statistics('TICKET_REPORTS'),
    ...statistics('TIME_REPORTS'),
  ];
  const planning = new Set([...statistics('TICKET_REPORTS'), ...statistics('TIME_REPORTS')]);
  const track = `#/tracks/${ids.track}`;
  const board = `#/boards/${ids.board}`;
  const admin = source('admin/sections.ts');
  const list = [
    ...sectionsIn(source, 'tracks/TrackLayout.tsx').map((s) =>
      route('track', `track-${s.id}`, `${track}${s.path}`),
    ),
    route('track', 'track-templates', `${track}/templates`),
    route('track', 'track-areas', `${track}/areas`),
    route('track', 'track-kanban-summary', `#/tracks/${ids.kanbanTrack}`),
    route('track', 'track-kanban-board', `#/tracks/${ids.kanbanTrack}/board`),
    route('track', 'track-kanban-statistics', `#/tracks/${ids.kanbanTrack}/statistics`),
    route('track', 'track-local-summary', `#/tracks/${ids.localTrack}`),
    route('track', 'boards-index', '#/boards'),
    route('track', 'board-by-id', board),
    route('track', 'board-settings', `${board}/settings`),
    route('track', 'board-backlog', `${board}/backlog`),
    route('track', 'board-reports', `${board}/reports`),
    route('track', 'board-sprint-report', `${board}/sprints/${ids.closedSprint}/report`),
    route('track', 'release', `#/releases/${ids.release}`),
    ...reports.map((r) =>
      route(
        planning.has(r) ? 'work' : 'track',
        `track-statistics-${r}`,
        `${track}/statistics/${r}`,
      ),
    ),
    route(
      'track',
      'track-statistics-sprint-report-closed',
      `${track}/statistics/sprint-report/${ids.closedSprint}`,
    ),

    route('work', 'home', '#/home'),
    route('work', 'inbox', '#/inbox'),
    route('work', 'tracks', '#/tracks'),
    route('work', 'tracks-new', '#/tracks?new'),
    route('work', 'search', '#/search'),
    route('work', 'search-results', `#/search?q=${encodeURIComponent(`track = ${ids.track}`)}`),
    route('work', 'search-saved', `#/search?savedSearch=${ids.savedSearch}`),
    route('work', 'dashboards', '#/dashboards'),
    route('work', 'dashboard', `#/dashboards/${ids.dashboard}`),
    route('work', 'dashboard-wallboard', `#/dashboards/${ids.dashboard}/wallboard`),
    route('work', 'plans', '#/plans'),
    ...sectionsIn(source, 'plans/address.ts').map((s) =>
      route('work', `plan-${s.id}`, `#/plans/${ids.plan}${s.path}`),
    ),
    route('work', 'ticket', `#/tickets/${ids.ticket}`),
    route('work', 'ticket-outcome', `#/tickets/${ids.outcome}`),
    route('work', 'create', '#/create'),
    route('work', 'bulk', `#/bulk/${ids.bulk}`),

    route('admin', 'admin', '#/admin'),
    ...[...admin.matchAll(/id: '([a-z]+)',\s*labelId: 'admin\.group\./g)].map((m) =>
      route('admin', `admin-group-${m[1]}`, `#/admin/group/${m[1]}`),
    ),
    ...[...admin.matchAll(/id: '([a-z-]+)',\s*href: '([^']+)'/g)].map((m) =>
      route('admin', `admin-${m[1]}`, m[2]),
    ),
    route('admin', 'admin-workflow-published', `#/admin/workflows/${ids.workflow}`),
    route('admin', 'admin-workflow-draft', `#/admin/workflows/${ids.workflowDraft}`),
    route('admin', 'admin-layouts-set', `#/admin/layouts?set=${ids.layoutSet}`),
    route('admin', 'admin-track-sets-track', `#/admin/track-sets?track=${ids.trackId}`),
    route('admin', 'manage-track', `#/manage/tracks/${ids.localTrackId}`),
    route('admin', 'manage-track-layouts', `#/manage/tracks/${ids.localTrackId}/layouts`),
    route(
      'admin',
      'manage-track-configuration-sets',
      `#/manage/tracks/${ids.localTrackId}/configuration-sets`,
    ),
    route('admin', 'manage-track-fields', `#/manage/tracks/${ids.localTrackId}/fields`),
    route(
      'admin',
      'manage-track-notification-policies',
      `#/manage/tracks/${ids.localTrackId}/notification-policies`,
    ),

    route('other', 'account', '#/account'),
    route('other', 'account-notifications', '#/account/notifications'),
    route('other', 'settings', '#/settings'),
    route('other', 'settings-tutorials', '#/settings/tutorials'),
    route('other', 'imported-link-unknown', '#/imported/filter/999999'),
    route('other', 'unknown-route', '#/no-such-page'),
    route('other', 'ticket-not-found', `#/tickets/${ids.track}-999999`),
    route('other', 'track-not-found', '#/tracks/NOSUCH'),
    route('other', 'board-not-found', '#/boards/999999'),
    route('other', 'release-not-found', '#/releases/999999'),
    route('other', 'dashboard-not-found', '#/dashboards/999999'),
    route('other', 'plan-not-found', '#/plans/999999'),
    route('other', 'bulk-not-found', '#/bulk/999999'),
    route('other', 'workflow-not-found', '#/admin/workflows/999999'),
    ...[
      ['signed-out-home', '#/home'],
      ['signed-out-tracks', '#/tracks'],
      ['signed-out-guarded', '#/inbox'],
      ['sign-in', '#/sign-in'],
      ['sign-in-password', '#/sign-in?method=password'],
      ['sign-in-sso-error', '#/sign-in?sso_error=no_account'],
      ['setup-no-link', '#/setup'],
      ['setup-invalid-link', '#/setup?token=not-a-real-link'],
      ['password-no-link', '#/password'],
      ['password-invalid-link', '#/password?token=not-a-real-link'],
      ['invite-no-link', '#/invite'],
      ['invite-invalid-link', '#/invite?token=not-a-real-link'],
      ['unsubscribe-no-link', '#/unsubscribe'],
      ['unsubscribe-invalid-link', '#/unsubscribe?token=not-a-real-link'],
      ['oauth-consent-no-request', '#/oauth/consent'],
      ['oauth-consent-invalid', '#/oauth/consent?request=not-a-real-one'],
    ].map(([slug, hash]) => route('other', slug, hash, { anon: true })),
  ];
  const missing = [];
  const routes = list.filter((r) => {
    if (/\b(undefined|null)\b/.test(r.route)) {
      missing.push({ slug: r.slug, why: 'the sample data for its id could not be made' });
      return false;
    }
    return true;
  });
  return { routes, missing };
}

/** Addresses the router and the admin list name that none of `routes` reaches. */
export function notCovered(routes, source) {
  const literals = new Set();
  for (const file of ['App.tsx', 'admin/sections.ts']) {
    for (const m of source(file).matchAll(/'(#\/[a-z/-]+)'/g)) literals.add(m[1]);
  }
  return [...literals].filter((l) => !routes.some((r) => r.route.split('?')[0].startsWith(l)));
}

/** The address for a route, in a language: `?locale=` wins over the account's without saving. */
export function addressOf(entry, locale, base) {
  if (entry.external) return entry.route;
  const joiner = entry.route.includes('?') ? '&' : '?';
  return `${base}/${entry.route}${joiner}locale=${locale}`;
}

/** The entries a run takes: all of them, or those whose slug or address holds `only`. */
export const choose = (entries, only) =>
  only ? entries.filter((r) => r.slug.includes(only) || r.route.includes(only)) : entries;

/** The pages shown in Spanish too: the main sections, and the longest English phone pages. */
export function spanishChoice(chosen, captures) {
  const longest = captures
    .filter((c) => c.width === 375 && c.skin === 'light' && c.locale === 'en' && c.height)
    .sort((a, b) => b.height - a.height)
    .map((c) => c.slug)
    .filter((s) => !s.startsWith('state-') && !SPANISH.includes(s))
    .slice(0, SPANISH_LONGEST);
  return chosen.filter((e) => SPANISH.includes(e.slug) || longest.includes(e.slug));
}

/** The file of one picture: the first window keeps the plain name, later ones are numbered. */
export const imageName = (slug, width, skin, window = 1) =>
  `${slug}--${width}--${skin}${window > 1 ? `--${window}` : ''}.png`;

/**
 * The later window pictures (`--2`, `--3` ...) of this route, width and skin among `files`: an
 * earlier run's, which a new capture with fewer windows would otherwise leave beside its own.
 */
export function laterWindowsIn(files, slug, width, skin) {
  const stem = imageName(slug, width, skin).slice(0, -'.png'.length);
  return files.filter((file) => {
    if (!file.startsWith(`${stem}--`) || !file.endsWith('.png')) return false;
    return /^\d+$/.test(file.slice(stem.length + 2, -'.png'.length));
  });
}

/**
 * Where each window of a phone picture starts, scrolling as a person would. A bar stuck to the top
 * or the bottom of the window covers what is under it, so each step is the window less those bars
 * and a little more, so nothing is left unseen between two pictures and a line cut at the foot of
 * one is whole in the next; the last window ends at the page's end.
 */
export function windowStops({ scrollHeight, innerHeight, stuckTop = 0, stuckBottom = 0 }) {
  const end = Math.max(0, Math.ceil(scrollHeight - innerHeight));
  // A bar that takes most of the window still lets the page move on by half a window.
  const step = Math.max(
    Math.floor(innerHeight / 2),
    Math.floor(innerHeight - stuckTop - stuckBottom - WINDOW_OVERLAP),
  );
  const stops = [0];
  while (stops.at(-1) < end && stops.length < MAX_WINDOWS) {
    stops.push(Math.min(end, (stops.at(-1) ?? 0) + step));
  }
  return { stops, step, cut: stops.at(-1) < end };
}

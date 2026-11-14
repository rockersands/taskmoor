import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addressOf,
  allRoutes,
  choose,
  combosFor,
  imageName,
  MAX_WINDOWS,
  namesIn,
  notCovered,
  parseSweepArgs,
  SPANISH,
  spanishChoice,
  windowStops,
} from './plan.mjs';

const LOG = '/work/.cache/sweep/demo.log';
const parse = (...argv) => parseSweepArgs(argv, { defaultLog: LOG });

describe('parseSweepArgs', () => {
  it('[NFR-007] takes both widths, the private demo port and the default log', () => {
    expect(parse('--out', 'shots')).toEqual({
      url: 'http://localhost:8090',
      out: 'shots',
      only: null,
      widths: [1280, 375],
      demo: false,
      log: LOG,
    });
  });

  it('[NFR-007] narrows to one route, one width, another address and the demo', () => {
    expect(
      parse(
        '--out=shots',
        '--only=home',
        '--width=375',
        '--url',
        'http://127.0.0.1:9000/',
        '--demo',
        '--log',
        'here.log',
      ),
    ).toEqual({
      url: 'http://127.0.0.1:9000',
      out: 'shots',
      only: 'home',
      widths: [375],
      demo: true,
      log: 'here.log',
    });
  });

  it.each([
    [[], '--out is needed'],
    [['--out', 'x', '--width', '414'], '--width is 1280 or 375'],
    [['--out', 'x', '--url', 'not an address'], '--url is not an address'],
    [['--out', 'x', '--url', 'file:///tmp/x'], '--url must be http or https'],
    [['--out', 'x', '--url', 'http://localhost', '--demo'], '--demo needs a port'],
    [['--out', 'x', '--only='], '--only needs some text'],
    [['--out', 'x', '--shots'], "Unknown option '--shots'"],
    [['--out', 'x', 'extra'], 'extra'],
  ])('[NFR-007] refuses %j with the usage line', (argv, message) => {
    expect(() => parse(...argv)).toThrow(message);
    expect(() => parse(...argv)).toThrow('Usage: pnpm sweep --out <dir>');
  });

  it('[NFR-008] never repeats a token given on the command line', () => {
    const refusals = [
      ['--out', 'x', '--token=abc123secret'],
      ['--out', 'x', '--', '--password=abc123secret'],
      ['--out', 'x', '--url', 'ftp://me:abc123secret@host/?token=abc123secret'],
    ].map((argv) => {
      try {
        parse(...argv);
        return '';
      } catch (error) {
        return error.message;
      }
    });
    for (const said of refusals) {
      expect(said).toContain('Usage');
      expect(said).not.toContain('abc123secret');
    }
  });
});

describe('combosFor', () => {
  it('[NFR-007] gives each width both skins, and marks the phone width as a phone', () => {
    expect(combosFor([1280, 375])).toEqual([
      { width: 1280, skin: 'light', phone: false },
      { width: 1280, skin: 'dark', phone: false },
      { width: 375, skin: 'light', phone: true },
      { width: 375, skin: 'dark', phone: true },
    ]);
  });
});

/** A small app: just enough of each file the route list reads. */
const FILES = {
  'tracks/TrackLayout.tsx': `export const TRACK_SECTIONS = [
  { id: 'summary', path: '', labelId: 'track.section.summary' },
  { id: 'board', path: '/board', labelId: 'track.section.board' },
] as const;`,
  'tracks/TrackStatisticsPage.tsx': `const SPRINT_REPORTS = ['sprint-report', 'velocity'] as const;
const TICKET_REPORTS = [
  'pie',
] as const;
const TIME_REPORTS = ['time-tracking'] as const;`,
  'reports/BoardReportsPage.tsx': `export const FLOW_REPORTS = ['control-chart'];`,
  'reports/ScopeReports.tsx': `export const SCOPE_REPORTS = ['burnup'];`,
  'plans/address.ts': `export const PLAN_SECTIONS = [
  { id: 'summary', path: '', labelId: 'plans.section.summary' },
  { id: 'timeline', path: '/timeline', labelId: 'plans.section.timeline' },
];`,
  'admin/sections.ts': `export const ADMIN_GROUPS = [
  { id: 'people', labelId: 'admin.group.people', pages: [
    { id: 'users', href: '#/admin/users', labelId: 'settings.users' },
    { id: 'api-usage', href: '#/admin/api-usage', labelId: 'settings.apiUsage' },
  ] },
];`,
  'App.tsx': `if (hash.startsWith('#/home')) return home; if (hash === '#/tracks') return tracks;`,
};
const fakeSource = (files) => (file) => {
  if (!(file in files)) throw new Error(`no ${file}`);
  return files[file];
};
const IDS = {
  track: 'MOB',
  trackId: 11,
  kanbanTrack: 'WEB',
  board: 3,
  closedSprint: 7,
  release: 5,
  savedSearch: 9,
  dashboard: 2,
  plan: 4,
  ticket: 'MOB-12',
  outcome: 'MOB-10',
  bulk: 6,
  workflow: 1,
  workflowDraft: 8,
  layoutSet: 12,
  localTrack: 'SWEEPL',
  localTrackId: 13,
};

describe('allRoutes', () => {
  it('[NFR-005] builds the track, plan, report and admin routes from the source, with real ids', () => {
    const { routes, missing } = allRoutes(IDS, fakeSource(FILES));
    const bySlug = Object.fromEntries(routes.map((r) => [r.slug, r]));
    expect(missing).toEqual([]);
    expect(bySlug['track-summary'].route).toBe('#/tracks/MOB');
    expect(bySlug['track-board']).toMatchObject({ group: 'track', route: '#/tracks/MOB/board' });
    expect(bySlug['plan-timeline']).toMatchObject({ group: 'work', route: '#/plans/4/timeline' });
    expect(bySlug['admin-group-people'].route).toBe('#/admin/group/people');
    expect(bySlug['admin-api-usage'].route).toBe('#/admin/api-usage');
    expect(bySlug['board-sprint-report'].route).toBe('#/boards/3/sprints/7/report');
    // Ticket and time reports are read as planning, so they sit with your work.
    expect(bySlug['track-statistics-pie'].group).toBe('work');
    expect(bySlug['track-statistics-time-tracking'].group).toBe('work');
    expect(bySlug['track-statistics-velocity'].group).toBe('track');
    expect(bySlug['track-statistics-control-chart'].route).toBe(
      '#/tracks/MOB/statistics/control-chart',
    );
    expect(bySlug['search-results'].route).toBe('#/search?q=track%20%3D%20MOB');
    // Pages for people signed out are opened without the session.
    expect(bySlug['sign-in'].anon).toBe(true);
    expect(bySlug['password-invalid-link'].anon).toBe(true);
    expect(bySlug.home.anon).toBeUndefined();
    expect(new Set(routes.map((r) => r.slug)).size).toBe(routes.length);
  });

  it('[NFR-005] reports the routes whose sample data is missing instead of opening them', () => {
    const { routes, missing } = allRoutes(
      { ...IDS, plan: undefined, closedSprint: null },
      fakeSource(FILES),
    );
    expect(missing.map((m) => m.slug).sort()).toEqual([
      'board-sprint-report',
      'plan-summary',
      'plan-timeline',
      'track-statistics-sprint-report-closed',
    ]);
    expect(routes.some((r) => /undefined|null/.test(r.route))).toBe(false);
  });

  it('[NFR-005] stops when a list it reads is gone from the app', () => {
    const files = { ...FILES, 'reports/ScopeReports.tsx': 'export const SCOPES = [];' };
    expect(() => allRoutes(IDS, fakeSource(files))).toThrow(
      "SCOPE_REPORTS is gone from reports/ScopeReports.tsx: the sweep's route list needs updating",
    );
    expect(namesIn(fakeSource(FILES), 'tracks/TrackStatisticsPage.tsx', 'TICKET_REPORTS')).toEqual([
      'pie',
    ]);
  });

  it('[NFR-005] reads the real app: every section list is still where the sweep looks', () => {
    const root = fileURLToPath(new URL('../../apps/web/src/', import.meta.url));
    const source = (file) => readFileSync(join(root, file), 'utf8');
    const { routes, missing } = allRoutes(IDS, source);
    const slugs = routes.map((r) => r.slug);
    expect(missing).toEqual([]);
    for (const slug of ['track-board', 'track-statistics', 'plan-summary', 'admin-users']) {
      expect(slugs).toContain(slug);
    }
    expect(routes.length).toBeGreaterThan(100);
  });
});

describe('notCovered', () => {
  it('[NFR-005] names the router addresses no route of the list reaches', () => {
    const source = fakeSource({
      ...FILES,
      'App.tsx': `'#/home' '#/tracks' '#/brand-new' '#/admin/users'`,
    });
    const { routes } = allRoutes(IDS, source);
    expect(notCovered(routes, source)).toEqual(['#/brand-new']);
  });
});

describe('addresses and choices', () => {
  it('[NFR-006] asks for the language in the address, after any query the route has', () => {
    const base = 'http://localhost:8090';
    expect(addressOf({ route: '#/home' }, 'es', base)).toBe(
      'http://localhost:8090/#/home?locale=es',
    );
    expect(addressOf({ route: '#/search?q=x' }, 'en', base)).toBe(
      'http://localhost:8090/#/search?q=x&locale=en',
    );
    expect(addressOf({ route: 'file:///b/index.html', external: true }, 'en', base)).toBe(
      'file:///b/index.html',
    );
  });

  it('[NFR-007] takes the routes whose name or address holds --only', () => {
    const entries = [
      { slug: 'home', route: '#/home' },
      { slug: 'state-create-dialog', route: '#/home' },
      { slug: 'inbox', route: '#/inbox' },
    ];
    expect(choose(entries, 'home').map((e) => e.slug)).toEqual(['home', 'state-create-dialog']);
    expect(choose(entries, 'inbox').map((e) => e.slug)).toEqual(['inbox']);
    expect(choose(entries, null)).toBe(entries);
  });

  it('[NFR-006] shows the main sections in Spanish, and the six longest other pages', () => {
    const chosen = ['home', 'ticket', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'state-x'].map((slug) => ({
      slug,
    }));
    const phone = (slug, height, more = {}) => ({
      slug,
      height,
      width: 375,
      skin: 'light',
      locale: 'en',
      ...more,
    });
    const captures = [
      phone('a', 9000),
      phone('b', 8000),
      phone('c', 7000),
      phone('d', 6000),
      phone('e', 5000),
      phone('f', 4000),
      phone('g', 3000),
      phone('state-x', 99_000),
      phone('home', 50_000),
      phone('g', 99_000, { skin: 'dark' }),
      phone('g', 99_000, { width: 1280 }),
    ];
    expect(SPANISH).toContain('home');
    expect(spanishChoice(chosen, captures).map((e) => e.slug)).toEqual([
      'home',
      'ticket',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('[NFR-007] names a picture by route, width and skin, and numbers later windows', () => {
    expect(imageName('home', 375, 'dark')).toBe('home--375--dark.png');
    expect(imageName('home', 375, 'dark', 1)).toBe('home--375--dark.png');
    expect(imageName('home', 375, 'dark', 3)).toBe('home--375--dark--3.png');
  });
});

describe('windowStops', () => {
  it('[NFR-007] takes one window when the page fits the phone', () => {
    expect(windowStops({ scrollHeight: 812, innerHeight: 812 })).toEqual({
      stops: [0],
      step: 812,
      cut: false,
    });
    expect(windowStops({ scrollHeight: 300, innerHeight: 812 }).stops).toEqual([0]);
  });

  it('[NFR-007] steps by the window less the stuck bars, and ends at the bottom of the page', () => {
    expect(windowStops({ scrollHeight: 2000, innerHeight: 812, stuckTop: 56 })).toEqual({
      stops: [0, 756, 1188],
      step: 756,
      cut: false,
    });
    // Bars that take most of the window still let the page move on by half a window.
    expect(
      windowStops({ scrollHeight: 2000, innerHeight: 800, stuckTop: 300, stuckBottom: 300 }).step,
    ).toBe(400);
  });

  it('[NFR-007] leaves nothing of the page unseen between two windows', () => {
    for (const innerHeight of [640, 740, 812]) {
      for (const stuckTop of [0, 48, 64, 500]) {
        for (const stuckBottom of [0, 56]) {
          for (let scrollHeight = 0; scrollHeight < 9000; scrollHeight += 173) {
            const { stops, step, cut } = windowStops({
              scrollHeight,
              innerHeight,
              stuckTop,
              stuckBottom,
            });
            const end = Math.max(0, scrollHeight - innerHeight);
            expect(stops[0]).toBe(0);
            expect(cut).toBe(false);
            expect(stops.at(-1)).toBe(end);
            for (let i = 1; i < stops.length; i += 1) {
              const moved = stops[i] - stops[i - 1];
              expect(moved).toBeGreaterThan(0);
              expect(moved).toBeLessThanOrEqual(step);
            }
            // What a stuck bar covers in one window is seen in the next.
            if (stuckTop + stuckBottom <= innerHeight / 2) {
              expect(step).toBeLessThanOrEqual(innerHeight - stuckTop - stuckBottom);
            }
          }
        }
      }
    }
  });

  it('[NFR-007] stops at a set number of windows and says the page was cut', () => {
    const { stops, cut } = windowStops({ scrollHeight: 100_000, innerHeight: 812 });
    expect(stops).toHaveLength(MAX_WINDOWS);
    expect(cut).toBe(true);
  });
});

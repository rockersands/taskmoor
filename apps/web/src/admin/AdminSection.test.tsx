import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { App, NAV_ITEMS } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
import type { User } from '../people/client';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { NotFoundPage } from '../shell/NotFoundPage';
import { stubBackend, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { fakeTrackPeopleClient } from '../trackpeople/fixtures';
import { TrackPeoplePage } from '../trackpeople/TrackPeoplePage';
import { AdminGroupPage } from './AdminGroupPage';
import { type AdminCrumb, AdminLayout, useAdminTrail } from './AdminLayout';
import { AdminOverviewPage, healthProblems, type OverviewClient } from './AdminOverviewPage';
import { RECENT_ALERTS } from './alertsFixtures';
import { ADMIN, CONFIG_ADMIN, HEALTHY, MEMBER, TRACK_ADMIN } from './fixtures';
import { ADMIN_GROUPS } from './sections';

const person = (id: number, name: string, fields: Partial<User> = {}): User => ({
  id,
  name,
  email: `${name.toLowerCase()}@example.com`,
  isSiteAdmin: false,
  active: true,
  hasPassword: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  deactivatedAt: null,
  lastSignInAt: '2026-10-02T00:00:00.000Z',
  ...fields,
});

const CLIENT: OverviewClient = {
  system: async () => HEALTHY,
  alerts: async () => RECENT_ALERTS,
  people: async () => ({
    users: [person(1, 'Ada'), person(2, 'Noor', { hasPassword: false, lastSignInAt: null })],
    total: 2,
  }),
};

function renderOverview(session: Session, client: OverviewClient = CLIENT) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <main>
          <AdminLayout hash="#/admin">
            <AdminOverviewPage client={client} />
          </AdminLayout>
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
}

const pagesNav = () => screen.getByRole('navigation', { name: 'Administration pages' });

/** A page that adds its own steps to the breadcrumb, as a track's or a workflow's page does. */
function Trail({ trail }: { trail: AdminCrumb[] | null }) {
  useAdminTrail(trail);
  return <p>Page</p>;
}

function renderAt(
  hash: string,
  session: Session,
  trail: AdminCrumb[] | null = null,
  page: ReactNode = <Trail trail={trail} />,
) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <main>
          <AdminLayout hash={hash}>{page}</AdminLayout>
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
}

describe('Administration (ADR-114)', () => {
  it('[AGL-018] is under Manage for those allowed, and leaves Tracks as it is', () => {
    stubBackend({ 'GET /*': () => jsonResponse(403, { error: 'forbidden' }) });
    window.location.hash = '#/settings';
    for (const session of [ADMIN, CONFIG_ADMIN]) {
      const { unmount } = render(<App session={session} />);
      const main = screen.getByRole('navigation', { name: 'Main' });
      const manage = within(main).getByRole('list', { name: 'Manage' });
      expect(within(manage).getByRole('link', { name: 'Administration' })).toHaveAttribute(
        'href',
        '#/admin',
      );
      expect(within(main).getAllByRole('link')).toHaveLength(NAV_ITEMS.length + 1);
      expect(within(main).getByRole('link', { name: 'Tracks' })).toHaveAttribute(
        'href',
        '#/tracks',
      );
      unmount();
    }
    render(<App session={MEMBER} />);
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).queryByRole('link', { name: 'Administration' })).toBeNull();
    expect(within(main).getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
  });

  it('[AGL-018] Settings is personal: account, appearance and tutorials', () => {
    window.location.hash = '#/settings';
    render(<App session={MEMBER} />);
    const page = screen.getByRole('region', { name: 'Settings' });
    expect(
      within(page)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Account', 'Appearance', 'Tutorials']);
  });

  it('[AGL-018] shows a site administrator every group, and health, people and alerts', async () => {
    renderOverview(ADMIN);
    for (const name of [
      'People and access',
      'Tracks and setup',
      'Sign-in and security',
      'Integrations and AI',
      'System',
    ]) {
      expect(within(pagesNav()).getByRole('button', { name })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(within(pagesNav()).getByRole('list', { name })).toBeVisible();
    }
    expect(within(pagesNav()).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const health = screen.getByRole('region', { name: 'System health' });
    expect(await within(health).findByText(/Everything looks fine/)).toBeVisible();
    expect(within(health).getByText(/Version 0\.4\.0/)).toBeVisible();
    const waiting = screen.getByRole('region', { name: 'People who have not signed in yet' });
    expect(await within(waiting).findByText('Noor')).toBeVisible();
    expect(within(waiting).queryByText('Ada')).toBeNull();
    const alerts = screen.getByRole('region', { name: 'Security alerts' });
    expect(await within(alerts).findByText(/from 203\.0\.113\.9/)).toBeVisible();
  });

  it('[AGL-018] keeps the other panels when one read fails', async () => {
    renderOverview(ADMIN, {
      ...CLIENT,
      system: async () => {
        throw new Error('down');
      },
    });
    expect(await screen.findByText(/health of this site could not be read/)).toBeVisible();
    expect(await screen.findByText('Noor')).toBeVisible();
  });

  it('[OPS-010] says what needs attention', () => {
    expect(healthProblems(HEALTHY)).toEqual([]);
    expect(
      healthProblems({
        ...HEALTHY,
        database: { ...HEALTHY.database, reachable: false },
        disk: { path: '/data', freeBytes: 1, totalBytes: 100 },
        backup: null,
      }),
    ).toEqual([
      'admin.overview.health.database',
      'admin.overview.health.disk',
      'admin.overview.health.backup',
    ]);
  });

  it('[IAM-030] shows a track manager only the tracks they run', () => {
    renderOverview({
      status: 'signed-in',
      user: {
        id: 3,
        name: 'Mina',
        email: 'mina@example.com',
        isSiteAdmin: false,
        isConfigAdmin: false,
        managesTracks: true,
        timeZone: null,
        locale: null,
      },
    });
    expect(within(pagesNav()).getByRole('link', { name: 'Tracks you run' })).toHaveAttribute(
      'href',
      '#/manage/tracks',
    );
    expect(within(pagesNav()).queryByRole('button', { name: 'Tracks and setup' })).toBeNull();
    expect(within(pagesNav()).queryByRole('link', { name: 'Workflow maps' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'System health' })).toBeNull();
  });

  it('[IAM-009] shows a configuration administrator only the setup pages, and no panels', () => {
    renderOverview(CONFIG_ADMIN);
    expect(within(pagesNav()).getByRole('button', { name: 'Tracks and setup' })).toBeVisible();
    expect(within(pagesNav()).getByRole('button', { name: 'Your tracks' })).toBeVisible();
    // Of People and access, only Visibility policies, which the server lets them change (T-322).
    expect(within(pagesNav()).getByRole('button', { name: 'People and access' })).toBeVisible();
    expect(within(pagesNav()).getAllByRole('button')).toHaveLength(3);
    expect(within(pagesNav()).getByRole('link', { name: 'Visibility policies' })).toHaveAttribute(
      'href',
      '#/admin/visibility',
    );
    expect(within(pagesNav()).queryByRole('link', { name: 'People' })).toBeNull();
    expect(within(pagesNav()).queryByRole('link', { name: 'Permission explainer' })).toBeNull();
    expect(within(pagesNav()).queryByRole('link', { name: 'System status' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'System health' })).toBeNull();
    const page = screen.getByRole('region', { name: 'Administration' });
    expect(within(page).getByRole('link', { name: 'Workflow maps' })).toBeVisible();
    expect(within(page).getByRole('link', { name: 'Visibility policies' })).toBeVisible();
  });

  it('[IAM-009] lists only Visibility policies on People and access for a configuration administrator (T-322)', () => {
    const people = ADMIN_GROUPS.find((g) => g.id === 'people') as (typeof ADMIN_GROUPS)[number];
    renderAt('#/admin/group/people', CONFIG_ADMIN, null, <AdminGroupPage group={people} />);
    const page = screen.getByRole('region', { name: 'People and access' });
    expect(
      within(page)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Visibility policies']);
    expect(screen.queryByText(/^Only site and configuration administrators/)).toBeNull();
  });

  it('[IAM-009] opens a setup page for a configuration administrator, not a site page', () => {
    stubBackend({
      'GET /tracks*': () => jsonResponse(200, { tracks: [] }),
      'GET /workflow-maps': () => jsonResponse(200, { workflowMaps: [] }),
      'GET /roles': () => jsonResponse(200, { roles: [] }),
      'GET /groups': () => jsonResponse(200, { groups: [] }),
    });
    window.location.hash = '#/admin/tracks';
    const { unmount } = render(<App session={CONFIG_ADMIN} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
    expect(screen.queryByText(/Only site administrators/)).toBeNull();
    unmount();
    window.location.hash = '#/admin/users';
    render(<App session={CONFIG_ADMIN} />);
    expect(screen.getByText(/Only site administrators/)).toBeVisible();
  });

  it('[AGL-018] gives every page a breadcrumb back to its group, whose page lists the group', async () => {
    const user = userEvent.setup();
    stubBackend({ 'GET /*': () => jsonResponse(403, { error: 'forbidden' }) });
    window.location.hash = '#/admin/guardrails';
    render(<App session={ADMIN} />);
    const crumbs = () => screen.getByRole('navigation', { name: 'Where this page sits' });
    expect(within(crumbs()).getByRole('link', { name: 'Administration' })).toHaveAttribute(
      'href',
      '#/admin',
    );
    expect(within(crumbs()).getByText('Guardrails')).toHaveAttribute('aria-current', 'page');
    await user.click(within(crumbs()).getByRole('link', { name: 'System' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeVisible();
    const page = screen.getByRole('region', { name: 'System' });
    expect(within(page).getByRole('link', { name: 'Trash' })).toHaveAttribute(
      'href',
      '#/admin/trash',
    );
  });

  it('[AGL-018] keeps the paths of every page', () => {
    const hrefs = ADMIN_GROUPS.flatMap((g) => g.pages.map((p) => p.href));
    expect(hrefs).toEqual(expect.arrayContaining(['#/admin/system', '#/admin/tokens']));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('[AGL-018] folds its navigation on a phone into one closed bar above every page, the overview too (D21)', () => {
    setViewportWidth(375);
    renderOverview(ADMIN);
    const bar = screen.getByText('Administration pages');
    expect(bar.tagName).toBe('SUMMARY');
    expect(bar).toHaveClass('admin-disclosure');
    expect(bar.closest('details')).not.toHaveAttribute('open');
    const title = screen.getByRole('heading', { level: 1, name: 'Administration' });
    expect(bar.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('[AGL-018] opens only the group of the page shown, and keeps a group opened by hand (D18)', async () => {
    const user = userEvent.setup();
    renderAt('#/admin/users', ADMIN);
    const people = within(pagesNav()).getByRole('button', { name: 'People and access' });
    expect(people).toHaveAttribute('aria-expanded', 'true');
    expect(within(pagesNav()).getByRole('link', { name: 'People' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const system = within(pagesNav()).getByRole('button', { name: 'System' });
    expect(system).toHaveAttribute('aria-expanded', 'false');
    expect(within(pagesNav()).queryByRole('link', { name: 'Trash' })).toBeNull();
    await user.click(system);
    expect(system).toHaveAttribute('aria-expanded', 'true');
    expect(within(pagesNav()).getByRole('link', { name: 'Trash' })).toBeVisible();
    await user.click(people);
    expect(within(pagesNav()).queryByRole('link', { name: 'People' })).toBeNull();
  });

  it('[AGL-018] marks the group heading current and open on a group page (D18)', () => {
    const system = ADMIN_GROUPS.find((g) => g.id === 'system') as (typeof ADMIN_GROUPS)[number];
    renderAt('#/admin/group/system', ADMIN, null, <AdminGroupPage group={system} />);
    const heading = within(pagesNav()).getByRole('button', { name: 'System' });
    expect(heading).toHaveAttribute('aria-current', 'page');
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    // The group page has the help mark beside its title (AD-20).
    expect(screen.getByRole('button', { name: 'What is System for?' })).toBeVisible();
    expect(
      within(pagesNav()).getByRole('button', { name: 'People and access' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('[AGL-018] ends the breadcrumb with what the page adds, the page itself a link back (AD-15, AD-28)', () => {
    renderAt('#/manage/tracks/4/layouts', TRACK_ADMIN, [
      { label: 'OPS', href: '#/manage/tracks/4' },
      { label: 'Layout sets' },
    ]);
    const crumbs = screen.getByRole('navigation', { name: 'Where this page sits' });
    expect(
      within(crumbs)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Administration', 'Your tracks', 'Tracks you run', 'OPS', 'Layout sets']);
    expect(within(crumbs).getByRole('link', { name: 'Tracks you run' })).toHaveAttribute(
      'href',
      '#/manage/tracks',
    );
    expect(within(crumbs).getByRole('link', { name: 'OPS' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );
    expect(within(crumbs).getByText('Layout sets')).toHaveAttribute('aria-current', 'page');
  });

  it('[AGL-018] a not-found page inside it marks nothing in its list, and the breadcrumb links back (D4, PL-43)', () => {
    window.location.hash = '#/admin/workflows/999';
    renderAt(
      '#/admin/workflows/999',
      ADMIN,
      null,
      <>
        <Trail trail={[{ label: 'Workflow not found' }]} />
        <NotFoundPage title="Workflow not found" />
      </>,
    );
    // The app's own navigation marks no section on a not-found page; this list follows it.
    expect(pagesNav().querySelectorAll('[aria-current]')).toHaveLength(0);
    const crumbs = screen.getByRole('navigation', { name: 'Where this page sits' });
    expect(within(crumbs).getByRole('link', { name: 'Workflows' })).toBeVisible();
    expect(within(crumbs).getByText('Workflow not found')).toHaveAttribute('aria-current', 'page');
    window.location.hash = '';
  });

  it('[IAM-030] names a group a track manager may not open without linking to it (T-227)', () => {
    renderAt('#/admin/layouts', TRACK_ADMIN);
    const crumbs = screen.getByRole('navigation', { name: 'Where this page sits' });
    expect(within(crumbs).getByText('Tracks and setup')).toBeVisible();
    expect(within(crumbs).queryByRole('link', { name: 'Tracks and setup' })).toBeNull();
    expect(within(crumbs).getByText('Layout sets')).toHaveAttribute('aria-current', 'page');
  });

  it('[IAM-030] links a track manager to no Setup page that refuses them, below a page that adds steps (T-227)', () => {
    // Someone who runs a track opens its own workflow; the list of workflows is for administrators.
    renderAt('#/admin/workflows/12', TRACK_ADMIN, [{ label: 'Ops flow' }]);
    const crumbs = screen.getByRole('navigation', { name: 'Where this page sits' });
    expect(
      within(crumbs)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Administration', 'Tracks and setup', 'Workflows', 'Ops flow']);
    expect(
      within(crumbs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Administration']);
    cleanup();
    // A configuration administrator still goes back to the list.
    renderAt('#/admin/workflows/12', CONFIG_ADMIN, [{ label: 'Ops flow' }]);
    expect(
      within(screen.getByRole('navigation', { name: 'Where this page sits' })).getByRole('link', {
        name: 'Workflows',
      }),
    ).toHaveAttribute('href', '#/admin/workflows');
  });

  it("[IAM-030] ends the breadcrumb of a track's people at the track (AD-15)", async () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={TRACK_ADMIN}>
          <main>
            <AdminLayout hash="#/manage/tracks/3">
              <TrackPeoplePage trackId={3} client={fakeTrackPeopleClient()} />
            </AdminLayout>
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    const crumbs = screen.getByRole('navigation', { name: 'Where this page sits' });
    expect(await within(crumbs).findByText('SHOP')).toHaveAttribute('aria-current', 'page');
    expect(within(crumbs).getByRole('link', { name: 'Tracks you run' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    render(
      <I18nProvider locale="en-XA">
        <SessionProvider session={ADMIN}>
          <main>
            <AdminLayout hash="#/admin">
              <AdminOverviewPage client={CLIENT} />
            </AdminLayout>
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    const main = screen.getByRole('main');
    await within(main).findByText(/203\.0\.113\.9/);
    const plain = visibleTexts(main).filter((t) => /^[a-zA-Z ]+$/.test(t));
    expect(plain.filter((t) => t !== 'Noor')).toEqual([]);
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App, NAV_ITEMS } from '../App';
import { I18nProvider } from '../i18n/I18nProvider';
import type { User } from '../people/client';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { stubBackend, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { AdminLayout } from './AdminLayout';
import { AdminOverviewPage, healthProblems, type OverviewClient } from './AdminOverviewPage';
import { RECENT_ALERTS } from './alertsFixtures';
import { ADMIN, CONFIG_ADMIN, HEALTHY, MEMBER } from './fixtures';
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
    for (const group of ADMIN_GROUPS) {
      expect(within(pagesNav()).getAllByRole('link').length).toBeGreaterThan(group.pages.length);
    }
    for (const name of [
      'People and access',
      'Tracks and setup',
      'Sign-in and security',
      'Integrations and AI',
      'System',
    ]) {
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
    expect(await screen.findByText(/health of this instance could not be read/)).toBeVisible();
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
    expect(within(pagesNav()).queryByRole('list', { name: 'Tracks and setup' })).toBeNull();
    expect(within(pagesNav()).queryByRole('link', { name: 'Workflow maps' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'System health' })).toBeNull();
  });

  it('[IAM-009] shows a configuration administrator only the setup pages, and no panels', () => {
    renderOverview(CONFIG_ADMIN);
    expect(within(pagesNav()).getByRole('list', { name: 'Tracks and setup' })).toBeVisible();
    expect(within(pagesNav()).getByRole('list', { name: 'Your tracks' })).toBeVisible();
    expect(within(pagesNav()).getAllByRole('list')).toHaveLength(3);
    expect(within(pagesNav()).queryByRole('link', { name: 'People' })).toBeNull();
    expect(within(pagesNav()).queryByRole('link', { name: 'System status' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'System health' })).toBeNull();
    const page = screen.getByRole('region', { name: 'Administration' });
    expect(within(page).getByRole('link', { name: 'Workflow maps' })).toBeVisible();
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

  it('[AGL-018] folds its navigation on a phone, open only on the overview', () => {
    setViewportWidth(375);
    renderOverview(ADMIN);
    expect(screen.getByText('Administration pages').closest('details')).toHaveAttribute('open');
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

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { ADMIN, HEALTHY, MEMBER, NEEDS_ATTENTION, STALE_BACKUP } from './fixtures';

function stubSystem(answer: () => Response) {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/admin/system') ? answer() : jsonResponse(401, { error: 'not_signed_in' }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const section = (name: string) => screen.getByRole('region', { name });
const fact = (region: string, label: string) => {
  const term = within(section(region)).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
};

describe('system status page', () => {
  it('[OPS-010] shows instance, database, storage and runtime to a site administrator', async () => {
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(200, HEALTHY));
    render(<App session={ADMIN} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'System status' })).toBeTruthy();
    // Healthy reads as success, not the accent (AD-33); the help mark is there (AD-20).
    expect(await screen.findByText('Connected')).toHaveClass('badge-success');
    expect(screen.getByRole('button', { name: 'What is System status for?' })).toBeVisible();
    expect(fact('Site', 'Version')).toBe('0.4.0');
    expect(fact('Site', 'Roles')).toBe('api, worker, realtime, web');
    expect(fact('Site', 'Uptime')).toBe('2 d 3 h 25 min');
    expect(fact('Database', 'PostgreSQL')).toBe('16.14');
    expect(fact('Database', 'Size')).toBe('4.8 GB');
    expect(fact('Database', 'Migrations')).toBe('2 applied');
    expect(fact('Database', 'Connections')).toBe('1 of 10 in use, 0 waiting');
    expect(fact('Storage', 'Free space')).toBe('182.3 GB free of 250 GB');
    expect(fact('Storage', 'Last backup')).toMatch(/\(0 d 6 h 0 min ago\)$/);
    expect(fact('Runtime', 'Memory')).toBe('187.4 MB');
    expect(fact('Scheduled backups', 'Schedule')).toBe(
      'Every day at 02:30 UTC, keeping the last 14',
    );
    expect(fact('Scheduled backups', 'Last success')).toMatch(/, 912\.4 MB$/);
    // An older failure is history once a backup succeeded after it.
    expect(within(section('Scheduled backups')).getByText(/could not connect/).className).toBe('');
    expect(fact('Scheduled backups', 'Restore drill')).toMatch(/restored in 412\.5 s$/);
    // Administration stays highlighted in the navigation.
    expect(
      screen.getAllByRole('link', { name: 'Administration' })[0]?.getAttribute('aria-current'),
    ).toBe('page');
  });

  it('[OPS-010] flags an unreachable database and a missing backup', async () => {
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(200, NEEDS_ATTENTION));
    render(<App session={ADMIN} />);
    expect((await screen.findByText('Unreachable')).className).toBe('status-bad');
    expect(fact('Database', 'Migrations')).toBe('Unknown');
    expect(fact('Database', 'Connections')).toBe('0 of 10 in use, 5 waiting');
    expect(screen.getByText('No backup yet').className).toBe('status-warn');
  });

  it('[OPS-010] warns about pending migrations and a backup older than a day', async () => {
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(200, STALE_BACKUP));
    render(<App session={ADMIN} />);
    expect((await screen.findByText('2 applied, 1 pending')).className).toBe('status-warn');
    expect(
      screen.getByText('Older than a day: take a backup before the next upgrade.'),
    ).toBeTruthy();
  });

  it('[OPS-008] flags a scheduled backup that failed since the last success, and a failed drill', async () => {
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(200, STALE_BACKUP));
    render(<App session={ADMIN} />);
    expect((await screen.findByText(/No space left on device/)).className).toBe('status-bad');
    expect(screen.getByText(/restored with other row counts/).className).toBe('status-bad');
    expect(fact('Scheduled backups', 'Next backup')).not.toBe('None');
  });

  it('[OPS-010] tells other users the page is for administrators, without asking the backend', async () => {
    window.location.hash = '#/admin/system';
    const fetch = stubSystem(() => jsonResponse(200, HEALTHY));
    render(<App session={MEMBER} />);
    expect(
      await screen.findByText('Only site administrators can see the system status.'),
    ).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/admin/system'))).toBe(false);
  });

  it('[OPS-010] treats a refusal from the backend the same way', async () => {
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(403, { error: 'forbidden' }));
    render(<App session={ADMIN} />);
    expect(
      await screen.findByText('Only site administrators can see the system status.'),
    ).toBeTruthy();
  });

  it('[OPS-010] reports a failure and recovers on refresh', async () => {
    window.location.hash = '#/admin/system';
    let up = false;
    stubSystem(() => (up ? jsonResponse(200, HEALTHY) : jsonResponse(500, { error: 'boom' })));
    render(<App session={ADMIN} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The system status could not be read. Try again in a moment.',
    );
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[OPS-010] asks anonymous visitors to sign in', async () => {
    window.location.hash = '#/admin/system';
    render(<App session={{ status: 'anonymous' }} />);
    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeTruthy();
  });

  it('[OPS-010] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(200, HEALTHY));
    render(<App session={ADMIN} />);
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('[OPS-010] links to the status from Administration for administrators only', async () => {
    window.location.hash = '#/admin';
    const { unmount } = render(<App session={ADMIN} />);
    expect((await screen.findByRole('link', { name: 'System status' })).getAttribute('href')).toBe(
      '#/admin/system',
    );
    unmount();
    render(<App session={MEMBER} />);
    expect(await screen.findByText(/Only site and configuration administrators/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'System status' })).toBeNull();
  });

  it('[OPS-010] offers System status in the command palette to administrators only', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App session={ADMIN} />);
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('system');
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/admin/system');
    unmount();
    window.location.hash = '';
    render(<App session={MEMBER} />);
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('system');
    expect(screen.queryByRole('option', { name: 'System status' })).toBeNull();
  });

  it('passes every string through the pseudo-locale', async () => {
    window.location.hash = '#/admin/system';
    stubSystem(() => jsonResponse(200, STALE_BACKUP));
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    await screen.findByRole('region', { name: /Ďàţàƀàšé|\[.*\]/ });
    const main = screen.getByRole('main');
    const texts: string[] = [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (text) texts.push(text);
    }
    expect(texts.length).toBeGreaterThan(20);
    expect(texts.filter((t) => !/^\[.+\]$/s.test(t))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

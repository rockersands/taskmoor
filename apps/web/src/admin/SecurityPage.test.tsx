import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { ALERT_DEFAULTS, RECENT_ALERTS } from './alertsFixtures';
import { ADMIN, MEMBER } from './fixtures';
import { inUnits, toMinutes } from './SessionPolicyForm';

const GROUPS = [
  { id: 3, name: 'Finance', description: '', memberCount: 4, childCount: 0 },
  { id: 7, name: 'Platform team', description: '', memberCount: 9, childCount: 1 },
];

const DEFAULTS = { lifetimeMinutes: 14 * 24 * 60, idleMinutes: 3 * 24 * 60 };

function openSecurity(handlers: Record<string, Handler> = {}, session = ADMIN) {
  const calls = stubBackend({
    'GET /security/two-factor': () => jsonResponse(200, { required: 'site_admins', groupIds: [7] }),
    'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
    'GET /security/sessions': () => jsonResponse(200, { ...DEFAULTS, defaults: DEFAULTS }),
    'GET /security/alerts': () =>
      jsonResponse(200, { rules: ALERT_DEFAULTS, defaults: ALERT_DEFAULTS, recent: RECENT_ALERTS }),
    ...handlers,
  });
  window.location.hash = '#/admin/security';
  render(<App session={session} />);
  return calls;
}

describe('security settings: two-factor policy', () => {
  it('[IAM-001] shows the current policy and saves a new one', async () => {
    const user = userEvent.setup();
    const calls = openSecurity({
      'PUT /security/two-factor': (body) => jsonResponse(200, body),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
    // The help mark beside the title, as on the other Administration pages (AD-20).
    expect(await screen.findByRole('button', { name: 'What is Security for?' })).toBeVisible();
    const form = await screen.findByRole('form', { name: 'Two-factor authentication' });
    const requiredFor = within(form).getByRole('group', { name: 'Required for' });
    expect(
      within(requiredFor)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['none', 'site_admins', 'everyone']);
    expect(within(requiredFor).getByRole('radio', { name: 'Site administrators' })).toBeChecked();
    const groups = within(form).getByRole('group', {
      name: 'Also required for members of these groups',
    });
    expect(within(groups).getByRole('checkbox', { name: 'Platform team' })).toBeChecked();
    expect(within(groups).getByRole('checkbox', { name: 'Finance' })).not.toBeChecked();

    await user.click(within(requiredFor).getByRole('radio', { name: 'Everyone' }));
    await user.click(within(groups).getByRole('checkbox', { name: 'Finance' }));
    await user.click(within(groups).getByRole('checkbox', { name: 'Platform team' }));
    await user.click(within(form).getByRole('button', { name: 'Save policy' }));
    expect(await within(form).findByText('Policy saved.')).toHaveAttribute('role', 'status');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/security/two-factor',
      body: { required: 'everyone', groupIds: [3], organizationDomains: [] },
    });
    // Settings stays highlighted in the navigation.
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Administration',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('[IAM-004] names the organization’s domains, so people at others are external', async () => {
    const user = userEvent.setup();
    const calls = openSecurity({
      'GET /security/two-factor': () =>
        jsonResponse(200, { required: 'none', groupIds: [], organizationDomains: ['example.com'] }),
      'PUT /security/two-factor': (body) => jsonResponse(200, body),
    });
    const domains = await screen.findByRole('textbox', {
      name: 'Your organisation’s email domains',
    });
    expect(domains).toHaveValue('example.com');
    expect(domains).toHaveAccessibleDescription(
      /people whose email is at any other domain are external/,
    );
    await user.type(domains, '\n@Example.ORG, example.com');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await screen.findByText('Policy saved.');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      required: 'none',
      groupIds: [],
      organizationDomains: ['example.com', 'example.org'],
    });
  });

  it('[IAM-001] is listed in Administration for site administrators only', async () => {
    stubBackend({});
    window.location.hash = '#/admin';
    const { unmount } = render(<App session={ADMIN} />);
    expect(await screen.findByRole('link', { name: 'Security' })).toHaveAttribute(
      'href',
      '#/admin/security',
    );
    unmount();
    render(<App session={MEMBER} />);
    await screen.findByRole('heading', { level: 1, name: 'Administration' });
    expect(screen.queryByRole('link', { name: 'Security' })).toBeNull();
  });

  it('[IAM-001] tells other people the page is for administrators, without asking the backend', async () => {
    const calls = openSecurity({}, MEMBER);
    expect(
      await screen.findByText('Only site administrators can change the security settings.'),
    ).toBeVisible();
    expect(calls.some((c) => c.path.startsWith('/security'))).toBe(false);
  });

  it('[IAM-001] treats a refusal from the backend the same way', async () => {
    openSecurity({ 'GET /security/two-factor': () => jsonResponse(403, { error: 'forbidden' }) });
    expect(
      await screen.findByText('Only site administrators can change the security settings.'),
    ).toBeVisible();
  });

  it('[IAM-001] still edits the policy when the groups cannot be read', async () => {
    openSecurity({ 'GET /groups': () => jsonResponse(500, { error: 'boom' }) });
    const form = await screen.findByRole('form', { name: 'Two-factor authentication' });
    expect(
      within(form).getByText('The groups could not be read. Try again in a moment.'),
    ).toBeVisible();
    expect(within(form).getByRole('radio', { name: 'Site administrators' })).toBeChecked();
  });

  it('[IAM-001] says when there are no groups', async () => {
    openSecurity({ 'GET /groups': () => jsonResponse(200, { groups: [] }) });
    expect(await screen.findByText('There are no groups yet.')).toBeVisible();
  });

  it('[IAM-001] reports a policy that could not be read or saved', async () => {
    const user = userEvent.setup();
    openSecurity({ 'PUT /security/two-factor': () => jsonResponse(500, { error: 'boom' }) });
    const form = await screen.findByRole('form', { name: 'Two-factor authentication' });
    await user.click(within(form).getByRole('button', { name: 'Save policy' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The policy could not be saved. Try again in a moment.',
    );
  });

  it('[IAM-001] reports a policy that could not be read', async () => {
    openSecurity({ 'GET /security/two-factor': () => jsonResponse(500, { error: 'boom' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The security settings could not be read. Try again in a moment.',
    );
  });

  it('[IAM-001] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    openSecurity();
    const form = await screen.findByRole('form', { name: 'Two-factor authentication' });
    expect(within(form).getByRole('radio', { name: 'Everyone' })).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Save policy' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    stubBackend({
      'GET /security/two-factor': () => jsonResponse(200, { required: 'none', groupIds: [] }),
      'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
    });
    window.location.hash = '#/admin/security';
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByRole('checkbox');
    const texts = visibleTexts(main);
    expect(texts.length).toBeGreaterThan(10);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('security settings: sign-in sessions', () => {
  it('[IAM-001] shows the defaults and saves the ASVS level-2 values', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    openSecurity({
      'PUT /security/sessions': (body) => {
        saved.push(body);
        return jsonResponse(200, body);
      },
    });
    const form = await screen.findByRole('form', { name: 'Sign-in sessions' });
    expect(within(form).getByText(/lasts 14 days and ends after 3 days unused/)).toBeVisible();
    // Each length is a number with a unit, in the unit that holds it whole (D22, AD-39).
    const lifetime = within(form).getByLabelText('A sign-in lasts');
    const idle = within(form).getByLabelText('Sign out after it goes unused for');
    const lifetimeUnit = within(form).getByRole('combobox', { name: 'Unit of “A sign-in lasts”' });
    const idleUnit = within(form).getByRole('combobox', {
      name: 'Unit of “Sign out after it goes unused for”',
    });
    expect(lifetime).toHaveValue(14);
    expect(lifetimeUnit).toHaveValue('days');
    expect(idle).toHaveValue(3);
    expect(idleUnit).toHaveValue('days');
    await user.clear(lifetime);
    await user.type(lifetime, '12');
    await user.selectOptions(lifetimeUnit, 'hours');
    await user.clear(idle);
    await user.type(idle, '30');
    await user.selectOptions(idleUnit, 'minutes');
    await user.click(within(form).getByRole('button', { name: 'Save session settings' }));
    expect(await within(form).findByText('Session settings saved.')).toBeVisible();
    expect(saved).toEqual([{ lifetimeMinutes: 720, idleMinutes: 30 }]);
  });

  it('[IAM-001] shows a length in the largest unit that holds it whole (D22)', () => {
    expect(inUnits(14 * 24 * 60)).toEqual({ amount: '14', unit: 'days' });
    expect(inUnits(720)).toEqual({ amount: '12', unit: 'hours' });
    expect(inUnits(90)).toEqual({ amount: '90', unit: 'minutes' });
    expect(toMinutes({ amount: '2', unit: 'days' })).toBe(2880);
    expect(toMinutes({ amount: '1.5', unit: 'hours' })).toBeNull();
    expect(toMinutes({ amount: ' ', unit: 'hours' })).toBeNull();
  });

  it('[IAM-001] refuses an idle time longer than the sign-in, before asking the server', async () => {
    const user = userEvent.setup();
    const calls = openSecurity();
    const form = await screen.findByRole('form', { name: 'Sign-in sessions' });
    const lifetime = within(form).getByLabelText('A sign-in lasts');
    const idle = within(form).getByLabelText('Sign out after it goes unused for');
    await user.clear(lifetime);
    await user.type(lifetime, '1');
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Unit of “A sign-in lasts”' }),
      'hours',
    );
    await user.clear(idle);
    await user.type(idle, '90');
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Unit of “Sign out after it goes unused for”' }),
      'minutes',
    );
    await user.click(within(form).getByRole('button', { name: 'Save session settings' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The idle time cannot be longer than the sign-in itself.',
    );
    expect(calls.some((c) => c.method === 'PUT' && c.path.startsWith('/security/sessions'))).toBe(
      false,
    );
  });
});

describe('security settings: alert rules (ADR-109)', () => {
  it('[IAM-018] ASVS 11.1.7: shows each rule with its default and the latest alerts, and saves a stricter rule', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    openSecurity({
      'PUT /security/alerts': (body) => {
        saved.push(body);
        const rules = (body as { rules: typeof ALERT_DEFAULTS }).rules;
        return jsonResponse(200, { rules, defaults: ALERT_DEFAULTS, recent: [] });
      },
    });
    const form = await screen.findByRole('form', { name: 'Security alerts' });
    const account = within(form).getByRole('group', { name: 'Failed sign-ins for one account' });
    expect(within(account).getByRole('checkbox', { name: 'Alert on this' })).toBeChecked();
    expect(within(account).getByLabelText('Alert after this many')).toHaveValue(10);
    expect(within(account).getByLabelText('Within this many minutes')).toHaveValue(60);
    expect(within(account).getByText('Default: 10 within 60 minutes.')).toBeVisible();
    const latest = within(form).getByRole('list', { name: 'Latest alerts' });
    expect(within(latest).getAllByRole('listitem')[0]).toHaveTextContent(
      /Failed sign-ins from one address: 25 in 15 minutes.*from 203\.0\.113\.9/,
    );

    const threshold = within(account).getByLabelText('Alert after this many');
    await user.clear(threshold);
    await user.type(threshold, '5');
    const exports = within(form).getByRole('group', { name: 'Bulk exports by one person' });
    await user.click(within(exports).getByRole('checkbox', { name: 'Alert on this' }));
    await user.click(within(form).getByRole('button', { name: 'Save alert rules' }));
    expect(await within(form).findByText('Alert rules saved.')).toBeVisible();
    expect(saved).toEqual([
      {
        rules: {
          ...ALERT_DEFAULTS,
          sign_in_failures_account: { enabled: true, threshold: 5, windowMinutes: 60 },
          bulk_exports: { enabled: false, threshold: 5, windowMinutes: 60 },
        },
      },
    ]);
    expect(within(form).getByText('No alert has been raised.')).toBeVisible();
  });

  it('[IAM-018] refuses a threshold out of range before asking the server', async () => {
    const user = userEvent.setup();
    const calls = openSecurity();
    const form = await screen.findByRole('form', { name: 'Security alerts' });
    const refusals = within(form).getByRole('group', {
      name: 'Refused requests of one person or token',
    });
    const threshold = within(refusals).getByLabelText('Alert after this many');
    await user.clear(threshold);
    await user.type(threshold, '0');
    await user.click(within(form).getByRole('button', { name: 'Save alert rules' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Choose a number from 1 to 100,000',
    );
    expect(calls.some((c) => c.method === 'PUT' && c.path.startsWith('/security/alerts'))).toBe(
      false,
    );
  });

  it('[NFR-006] the alert rules work on a phone and every text comes from the catalogue', async () => {
    setViewportWidth(360);
    openSecurity();
    const form = await screen.findByRole('form', { name: 'Security alerts' });
    expect(within(form).getByRole('button', { name: 'Save alert rules' })).toBeVisible();
    stubBackend({
      'GET /security/two-factor': () => jsonResponse(200, { required: 'none', groupIds: [] }),
      'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
      'GET /security/sessions': () => jsonResponse(200, { ...DEFAULTS, defaults: DEFAULTS }),
      'GET /security/alerts': () =>
        jsonResponse(200, {
          rules: ALERT_DEFAULTS,
          defaults: ALERT_DEFAULTS,
          recent: RECENT_ALERTS,
        }),
    });
    cleanup();
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const recent = await waitFor(() => {
      const list = document.querySelector('.security-alerts-list');
      expect(list).not.toBeNull();
      return list as HTMLElement;
    });
    const alerts = recent.closest('form') as HTMLElement;
    expect(untranslated(visibleTexts(alerts))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

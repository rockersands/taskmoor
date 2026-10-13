import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { ADMIN, MEMBER } from './fixtures';

const GROUPS = [
  { id: 3, name: 'Finance', description: '', memberCount: 4, childCount: 0 },
  { id: 7, name: 'Platform team', description: '', memberCount: 9, childCount: 1 },
];

function openSecurity(handlers: Record<string, Handler> = {}, session = ADMIN) {
  const calls = stubBackend({
    'GET /security/two-factor': () => jsonResponse(200, { required: 'site_admins', groupIds: [7] }),
    'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
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
      body: { required: 'everyone', groupIds: [3] },
    });
    // Settings stays highlighted in the navigation.
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('[IAM-001] is linked from Settings for site administrators only', async () => {
    stubBackend({});
    window.location.hash = '#/settings';
    const { unmount } = render(<App session={ADMIN} />);
    expect(await screen.findByRole('link', { name: 'Security' })).toHaveAttribute(
      'href',
      '#/admin/security',
    );
    unmount();
    render(<App session={MEMBER} />);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
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

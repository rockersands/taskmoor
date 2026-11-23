import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { type Handler, noContent, stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { ApiToken, ServiceAccount } from './client';
import {
  inventoryTokens,
  POLICY,
  ROBOT_OWNER,
  sampleServiceAccounts,
  sampleToken,
} from './fixtures';

const SECRET = 'tmk_EXAMPLE_ONLY_not_a_real_token_000077';

function accountsBackend(extra: Record<string, Handler> = {}) {
  let accounts = sampleServiceAccounts();
  let tokens = inventoryTokens().filter((t) => t.owner.kind === 'service');
  const view = (a: ServiceAccount) => ({
    ...a,
    activeTokens: tokens.filter((t) => t.owner.id === a.id && t.status === 'active').length,
  });
  return stubBackend({
    'GET /service-accounts?status=all': () =>
      jsonResponse(200, { serviceAccounts: accounts.map(view) }),
    'GET /admin/token-policy': () => jsonResponse(200, { policy: POLICY }),
    'GET /service-accounts/7': () => jsonResponse(200, { tokens }),
    'GET /service-accounts/8': () => jsonResponse(200, { tokens: [] }),
    'POST /service-accounts': (body) => {
      const { name, description } = body as { name: string; description: string };
      const account: ServiceAccount = {
        id: 9,
        name,
        description,
        email: 'ci-deploy@service.invalid',
        active: true,
        createdAt: new Date().toISOString(),
        deactivatedAt: null,
        activeTokens: 0,
      };
      accounts = [...accounts, account];
      return jsonResponse(201, { serviceAccount: account });
    },
    'GET /service-accounts/9': () => jsonResponse(200, { tokens: [] }),
    'PATCH /service-accounts/7': (body) => {
      accounts = accounts.map((a) => (a.id === 7 ? { ...a, ...(body as object) } : a));
      return jsonResponse(200, { serviceAccount: view(accounts[0] as ServiceAccount) });
    },
    'POST /service-accounts/7/deactivate': () => {
      accounts = accounts.map((a) => (a.id === 7 ? { ...a, active: false } : a));
      return jsonResponse(200, { serviceAccount: accounts[0] });
    },
    'POST /service-accounts/8/reactivate': () => {
      accounts = accounts.map((a) => (a.id === 8 ? { ...a, active: true } : a));
      return jsonResponse(200, { serviceAccount: accounts[1] });
    },
    'POST /service-accounts/7/tokens/62/rotate': (body) => {
      const { overlapHours } = body as { overlapHours: number };
      const old = tokens.find((t) => t.id === 62) as ApiToken;
      const apiToken = sampleToken({ ...old, id: 63, lastUsedAt: null, lastUsedIp: null });
      const previous: ApiToken = {
        ...old,
        replacedBy: 63,
        expiresAt: new Date(Date.now() + overlapHours * 3_600_000).toISOString(),
      };
      tokens = [apiToken, ...tokens.map((t) => (t.id === 62 ? previous : t))];
      return jsonResponse(201, { token: SECRET, apiToken, previous });
    },
    'POST /service-accounts/7/tokens': (body) => {
      const input = body as { name: string; scopes: ApiToken['scopes'] };
      const apiToken = sampleToken({
        id: 70,
        name: input.name,
        scopes: input.scopes,
        owner: ROBOT_OWNER,
      });
      tokens = [apiToken, ...tokens];
      return jsonResponse(201, { token: SECRET, apiToken });
    },
    'DELETE /admin/tokens/62': () => {
      tokens = tokens.map((t) =>
        t.id === 62 ? { ...t, status: 'revoked', revokedAt: new Date().toISOString() } : t,
      );
      return noContent();
    },
    ...extra,
  });
}

async function openPage(extra: Record<string, Handler> = {}) {
  const calls = accountsBackend(extra);
  window.location.hash = '#/admin/service-accounts';
  render(<App session={ADMIN} />);
  await screen.findByRole('heading', { level: 1, name: 'Service accounts' });
  const list = within(screen.getByRole('region', { name: 'Service accounts of this site' }));
  await list.findAllByRole('listitem');
  return { calls, list };
}

const robot = () =>
  screen
    .getAllByRole('listitem')
    .find(
      (li) =>
        li.classList.contains('service-account-item') && li.textContent?.includes('Release robot'),
    ) as HTMLElement;

describe('service accounts page', () => {
  it('[IAM-007] lists service accounts with their address, tokens and state', async () => {
    const { list } = await openPage();
    const accounts = list.getAllByRole('listitem');
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toHaveTextContent('Release robot');
    expect(accounts[0]).toHaveTextContent('Address release-robot@service.invalid');
    expect(accounts[0]).toHaveTextContent('2 active tokens');
    expect(accounts[0]).toHaveTextContent('Tags releases and publishes notes');
    expect(accounts[1]).toHaveTextContent('Deactivated');
    expect(
      within(accounts[1] as HTMLElement).getByRole('button', {
        name: 'Reactivate Backup exporter',
      }),
    ).toBeVisible();
  });

  it('[IAM-007] creates a service account and opens its tokens', async () => {
    const user = userEvent.setup();
    const { calls } = await openPage();
    // The accounts come first; "New service account" opens the form (D11, AD-18).
    expect(screen.queryByRole('form', { name: 'Create service account' })).toBeNull();
    const opener = screen.getByRole('button', { name: 'New service account' });
    expect(opener).toHaveClass('button-primary');
    await user.click(opener);
    const form = within(screen.getByRole('form', { name: 'Create service account' }));
    await user.type(form.getByLabelText('Name'), 'CI deploy');
    await user.type(form.getByLabelText('What it is for'), 'Deploys main');
    await user.click(form.getByRole('button', { name: 'Create service account' }));
    expect(await screen.findByText('Created CI deploy.')).toHaveAttribute('role', 'status');
    // Created, the form closes and the focus goes back to the New button.
    expect(screen.queryByRole('form', { name: 'Create service account' })).toBeNull();
    expect(opener).toHaveFocus();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'CI deploy',
      description: 'Deploys main',
    });
    expect(await screen.findByRole('region', { name: 'Tokens of CI deploy' })).toBeVisible();
    expect(screen.getByText('This service account has no tokens.')).toBeVisible();
  });

  it('[IAM-007] gives a service account a token, shown once, with the administration scope offered', async () => {
    const user = userEvent.setup();
    const { calls } = await openPage();
    await user.click(
      within(robot()).getByRole('button', { name: 'Show the tokens of Release robot' }),
    );
    const tokens = within(await screen.findByRole('region', { name: 'Tokens of Release robot' }));
    await tokens.findByRole('list', { name: 'Tokens of Release robot' });
    await user.type(tokens.getByLabelText('Token name'), 'Changelog key');
    await user.click(tokens.getByRole('checkbox', { name: 'Administration' }));
    await user.click(tokens.getByRole('button', { name: 'Create token' }));
    expect(await tokens.findByLabelText('New token')).toHaveValue(SECRET);
    expect(calls.find((c) => c.path === '/service-accounts/7/tokens')?.body).toEqual({
      name: 'Changelog key',
      scopes: ['read', 'admin'],
      expiresInDays: 30,
    });
  });

  it('[IAM-006] gives a service account a SCIM provisioning token, which goes alone', async () => {
    const user = userEvent.setup();
    const { calls } = await openPage();
    await user.click(
      within(robot()).getByRole('button', { name: 'Show the tokens of Release robot' }),
    );
    const tokens = within(await screen.findByRole('region', { name: 'Tokens of Release robot' }));
    await tokens.findByRole('list', { name: 'Tokens of Release robot' });
    await user.type(tokens.getByLabelText('Token name'), 'Entra ID provisioning');
    const scim = tokens.getByRole('checkbox', { name: 'SCIM provisioning' });
    expect(tokens.getByText(/at \/api\/v1\/scim\/v2 on this site/)).toBeVisible();
    await user.click(scim);
    // Choosing SCIM clears the others; choosing another clears SCIM.
    expect(tokens.getByRole('checkbox', { name: 'Read' })).not.toBeChecked();
    await user.click(tokens.getByRole('checkbox', { name: 'Write' }));
    expect(scim).not.toBeChecked();
    await user.click(scim);
    expect(tokens.getByRole('checkbox', { name: 'Write' })).not.toBeChecked();
    await user.click(tokens.getByRole('button', { name: 'Create token' }));
    expect(await tokens.findByLabelText('New token')).toHaveValue(SECRET);
    expect(calls.find((c) => c.path === '/service-accounts/7/tokens')?.body).toEqual({
      name: 'Entra ID provisioning',
      scopes: ['scim'],
      expiresInDays: 30,
    });
  });

  it('[IAM-007] rotates a token with the chosen overlap and shows the new one once', async () => {
    const user = userEvent.setup();
    const { calls } = await openPage();
    await user.click(
      within(robot()).getByRole('button', { name: 'Show the tokens of Release robot' }),
    );
    const tokens = within(await screen.findByRole('region', { name: 'Tokens of Release robot' }));
    const list = await tokens.findByRole('list', { name: 'Tokens of Release robot' });
    // The token already replaced offers no second rotation.
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Replaced');
    expect(within(items[0] as HTMLElement).queryByRole('button', { name: /^Rotate/ })).toBeNull();

    await user.selectOptions(
      tokens.getByLabelText('After rotating, the old token keeps working for'),
      '72',
    );
    await user.click(
      within(items[1] as HTMLElement).getByRole('button', { name: 'Rotate Release key' }),
    );
    expect(await tokens.findByText('Rotated Release key. Copy the new token now.')).toBeVisible();
    expect(tokens.getByLabelText('New token')).toHaveValue(SECRET);
    expect(calls.find((c) => c.path.endsWith('/rotate'))?.body).toEqual({ overlapHours: 72 });
    await waitFor(() =>
      expect(within(tokens.getByRole('list')).getAllByRole('listitem')).toHaveLength(3),
    );
  });

  it('[IAM-007] revokes a service-account token', async () => {
    const user = userEvent.setup();
    const { calls } = await openPage();
    await user.click(
      within(robot()).getByRole('button', { name: 'Show the tokens of Release robot' }),
    );
    const tokens = within(await screen.findByRole('region', { name: 'Tokens of Release robot' }));
    const list = await tokens.findByRole('list', { name: 'Tokens of Release robot' });
    const item = within(within(list).getAllByRole('listitem')[1] as HTMLElement);
    const trigger = item.getByRole('button', { name: 'Revoke Release key' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13).
    const question = item.getByRole('group', { name: /^Revoke Release key\? Programs using it/ });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(question).getByRole('button', { name: 'Revoke Release key' }));
    expect(await tokens.findByText('Revoked Release key.')).toBeVisible();
    expect(tokens.getByRole('heading', { name: 'Tokens of Release robot' })).toHaveFocus();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/tokens/62')).toBe(true);
  });

  it('[IAM-007] deactivates and reactivates service accounts', async () => {
    const user = userEvent.setup();
    const { calls, list } = await openPage();
    const trigger = list.getByRole('button', { name: 'Deactivate Release robot' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what stops (D13); Escape gives the focus back and sends nothing.
    const question = list.getByRole('group', { name: /^Release robot stops working at once: / });
    expect(question).toHaveAccessibleName(
      'Release robot stops working at once: its 2 active tokens are refused, and no new token can be issued until you reactivate it.',
    );
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(list.getByRole('button', { name: 'Deactivate Release robot' })).toHaveFocus();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(list.getByRole('button', { name: 'Deactivate Release robot' }));
    await user.click(
      within(list.getByRole('group')).getByRole('button', { name: 'Deactivate Release robot' }),
    );
    expect(await list.findByRole('button', { name: 'Reactivate Release robot' })).toBeVisible();
    expect(list.getByRole('button', { name: 'Show the tokens of Release robot' })).toHaveFocus();
    await user.click(list.getByRole('button', { name: 'Reactivate Backup exporter' }));
    expect(await list.findByRole('button', { name: 'Deactivate Backup exporter' })).toBeVisible();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/service-accounts/7/deactivate',
      '/service-accounts/8/reactivate',
    ]);
  });

  it('[IAM-007] renames a service account and says what it is for (T-320)', async () => {
    const user = userEvent.setup();
    const { calls, list } = await openPage();
    const change = list.getByRole('button', {
      name: 'Change the name and description of Release robot',
    });
    await user.click(change);
    expect(change).toHaveAttribute('aria-expanded', 'true');
    const form = list.getByRole('form', {
      name: 'Change the name and description of Release robot',
    });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Release tagger');
    const about = within(form).getByRole('textbox', { name: 'What it is for' });
    await user.clear(about);
    await user.type(about, 'Tags releases');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Release tagger was saved.')).toBeInTheDocument();
    expect(list.queryByRole('form')).toBeNull();
    const renamed = list.getByRole('button', {
      name: 'Change the name and description of Release tagger',
    });
    expect(renamed).toHaveFocus();
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([
      {
        method: 'PATCH',
        path: '/service-accounts/7',
        body: { name: 'Release tagger', description: 'Tags releases' },
      },
    ]);
    // Cancel closes the form unchanged, the focus back on Change.
    await user.click(renamed);
    await user.click(within(list.getByRole('form')).getByRole('button', { name: 'Cancel' }));
    expect(list.queryByRole('form')).toBeNull();
    expect(renamed).toHaveFocus();
  });

  it('[IAM-007] says when a service account could not be saved (T-320)', async () => {
    const user = userEvent.setup();
    const { list } = await openPage({
      'PATCH /service-accounts/8': () => jsonResponse(500, { error: 'internal' }),
    });
    await user.click(
      list.getByRole('button', { name: 'Change the name and description of Backup exporter' }),
    );
    const form = list.getByRole('form', {
      name: 'Change the name and description of Backup exporter',
    });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The service account could not be saved. Try again in a moment.',
    );
  });

  it('[IAM-007] is for site administrators only', async () => {
    const calls = stubBackend({});
    window.location.hash = '#/admin/service-accounts';
    render(<App session={MEMBER} />);
    expect(
      await screen.findByText('Only site administrators can manage service accounts.'),
    ).toBeVisible();
    expect(calls.filter((c) => c.path.startsWith('/service-accounts'))).toEqual([]);
  });

  it('[IAM-007] says when the list could not be read', async () => {
    accountsBackend({
      'GET /service-accounts?status=all': () => jsonResponse(500, { error: 'boom' }),
    });
    window.location.hash = '#/admin/service-accounts';
    render(<App session={ADMIN} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service accounts could not be read. Try again in a moment.',
    );
  });

  it('[IAM-007] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const { list } = await openPage();
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'New service account' })).toBeVisible();
  });
});

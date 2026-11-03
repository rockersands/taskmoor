import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { type Handler, noContent, stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { ApiToken, BulkCriteria, TokenPolicy } from './client';
import { inventoryTokens, LIMITS, ownersOf, POLICY } from './fixtures';

/** A backend that keeps the inventory and the policy, like the real one. */
function inventoryBackend(extra: Record<string, Handler> = {}) {
  let tokens = inventoryTokens();
  let policy: TokenPolicy = POLICY;
  const revoke = (t: ApiToken): ApiToken => ({
    ...t,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
  });
  const live = (t: ApiToken) => t.status === 'active';
  const matches = (t: ApiToken, c: BulkCriteria) =>
    live(t) &&
    ('all' in c ||
      ('ownerId' in c && t.owner.id === c.ownerId) ||
      ('createdBefore' in c && Date.parse(t.createdAt) < Date.parse(c.createdBefore)));
  const list = (shown: ApiToken[]) =>
    jsonResponse(200, { tokens: shown, total: shown.length, owners: ownersOf(tokens) });
  return stubBackend({
    'GET /admin/tokens?status=all&limit=500': () => list(tokens),
    'GET /admin/tokens?status=revoked&limit=500': () =>
      list(tokens.filter((t) => t.status === 'revoked')),
    'GET /admin/tokens?status=active&limit=1': () => list(tokens.filter(live).slice(0, 1)),
    'GET /admin/tokens/expiring': () =>
      jsonResponse(200, {
        withinDays: policy.reminderDays,
        tokens: tokens.filter(
          (t) =>
            live(t) &&
            t.replacedBy === null &&
            Date.parse(t.expiresAt) - Date.now() <= policy.reminderDays * 86_400_000,
        ),
      }),
    'GET /admin/token-policy': () => jsonResponse(200, { policy, limits: LIMITS }),
    'PUT /admin/token-policy': (body) => {
      policy = body as TokenPolicy;
      return jsonResponse(200, { policy, limits: LIMITS });
    },
    'DELETE /admin/tokens/*': (_body, path) => {
      const id = Number(path.split('/').pop());
      tokens = tokens.map((t) => (t.id === id ? revoke(t) : t));
      return noContent();
    },
    'POST /admin/tokens/revoke': (body) => {
      const { dryRun, ...criteria } = body as BulkCriteria & { dryRun: boolean };
      const count = tokens.filter((t) => matches(t, criteria)).length;
      if (dryRun) return jsonResponse(200, { matched: count });
      tokens = tokens.map((t) => (matches(t, criteria) ? revoke(t) : t));
      return jsonResponse(200, { revoked: count });
    },
    ...extra,
  });
}

async function openPage(extra: Record<string, Handler> = {}) {
  const calls = inventoryBackend(extra);
  window.location.hash = '#/admin/tokens';
  render(<App session={ADMIN} />);
  await screen.findByRole('heading', { level: 1, name: 'API tokens' });
  const tokens = within(screen.getByRole('region', { name: 'Tokens' }));
  await tokens.findByRole('list', { name: 'Tokens' });
  return { calls, tokens, region: (name: string) => within(screen.getByRole('region', { name })) };
}

const items = (list: ReturnType<typeof within>) =>
  within(list.getByRole('list', { name: 'Tokens' })).getAllByRole('listitem');

describe('admin token inventory', () => {
  it('[IAM-007] lists every token with its owner, scopes, last use and status', async () => {
    const { tokens } = await openPage();
    expect(tokens.getByText('8 tokens')).toBeVisible();
    const all = items(tokens);
    expect(all).toHaveLength(8);
    const sync = all.find((li) => li.textContent?.includes('Sync job')) as HTMLElement;
    expect(sync).toHaveTextContent('River Stone (river@example.com)');
    expect(sync).toHaveTextContent(/Last used .* from 203\.0\.113\.7/);
    const release = all.filter((li) => li.textContent?.includes('Release key'));
    expect(release).toHaveLength(2);
    expect(release[0]).toHaveTextContent('Service account');
    expect(release[0]).toHaveTextContent('Replaced');
    expect(release[0]).toHaveTextContent('Scopes: Read, Write, and Administration');
    expect(
      within(release[1] as HTMLElement).getByRole('button', {
        name: 'Revoke Release key of Release robot',
      }),
    ).toBeVisible();
  });

  it('[IAM-007] shows the tokens due for rotation and the revoked ones on request', async () => {
    const user = userEvent.setup();
    const { calls, tokens } = await openPage();
    await user.selectOptions(tokens.getByLabelText('Show'), 'expiring');
    await waitFor(() => expect(items(tokens)).toHaveLength(1));
    expect(items(tokens)[0]).toHaveTextContent('Weekly report');
    expect(items(tokens)[0]).toHaveTextContent('Expires in 5 days');
    expect(calls.some((c) => c.path === '/admin/tokens/expiring')).toBe(true);

    await user.selectOptions(tokens.getByLabelText('Show'), 'revoked');
    await waitFor(() => expect(items(tokens)).toHaveLength(1));
    expect(items(tokens)[0]).toHaveTextContent('Old laptop');
  });

  it('[IAM-007] revokes one token of anyone', async () => {
    const user = userEvent.setup();
    const { calls, tokens } = await openPage();
    await user.click(tokens.getByRole('button', { name: 'Revoke Sync job of River Stone' }));
    expect(await tokens.findByText('Revoked Sync job of River Stone.')).toHaveAttribute(
      'role',
      'status',
    );
    await waitFor(() =>
      expect(tokens.queryByRole('button', { name: 'Revoke Sync job of River Stone' })).toBeNull(),
    );
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/admin/tokens/51')).toBe(true);
  });

  it('[IAM-007] revokes every token of one owner after saying how many it will revoke', async () => {
    const user = userEvent.setup();
    const { calls, region, tokens } = await openPage();
    const bulk = region('Revoke in bulk');
    expect(bulk.getByRole('radio', { name: 'Every token of one owner' })).toBeChecked();
    const owner = bulk.getByLabelText('Owner');
    expect(within(owner).getByRole('option', { name: /^Kalo Mendes/ })).toHaveTextContent(
      'Kalo Mendes (kalo@example.com): 3 active tokens',
    );
    await user.selectOptions(owner, '1');
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    expect(
      await bulk.findByText(
        'This revokes 3 active tokens. Programs using them stop working at once.',
      ),
    ).toBeVisible();
    const confirm = bulk.getByRole('button', { name: 'Confirm revocation' });
    expect(confirm).toHaveFocus();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/admin/tokens/revoke', body: { ownerId: 1, dryRun: true } },
    ]);
    await user.click(confirm);
    expect(await bulk.findByText('Revoked 3 tokens.')).toHaveAttribute('role', 'status');
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      ownerId: 1,
      dryRun: false,
    });
    // The list is read again: none of Kalo's tokens can be revoked any more.
    await waitFor(() =>
      expect(tokens.queryByRole('button', { name: /of Kalo Mendes$/ })).toBeNull(),
    );
    expect(
      within(bulk.getByLabelText('Owner')).getByRole('option', { name: /^Kalo Mendes/ }),
    ).toHaveTextContent('no active tokens');
  });

  it('[IAM-007] revokes tokens created before a day, or every token, and can be cancelled', async () => {
    const user = userEvent.setup();
    const { calls, region } = await openPage();
    const bulk = region('Revoke in bulk');
    // The fixture tokens were created 20 days ago, so a day 10 days back matches them.
    const before = new Date(Date.now() - 10 * 86_400_000);
    const day = [
      before.getFullYear(),
      String(before.getMonth() + 1).padStart(2, '0'),
      String(before.getDate()).padStart(2, '0'),
    ].join('-');
    await user.click(bulk.getByRole('radio', { name: 'Tokens created before a day' }));
    await user.type(bulk.getByLabelText('Created before'), day);
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    await bulk.findByRole('button', { name: 'Confirm revocation' });
    const preview = calls.filter((c) => c.method === 'POST').at(-1)?.body as {
      createdBefore: string;
    };
    expect(new Date(preview.createdBefore).getTime()).toBe(new Date(`${day}T00:00:00`).getTime());
    await user.click(bulk.getByRole('button', { name: 'Cancel' }));
    expect(bulk.queryByRole('button', { name: 'Confirm revocation' })).toBeNull();

    await user.click(bulk.getByRole('radio', { name: 'Every token' }));
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    expect(await bulk.findByText(/^This revokes 6 active tokens\./)).toBeVisible();
    await user.click(bulk.getByRole('button', { name: 'Confirm revocation' }));
    expect(await bulk.findByText('Revoked 6 tokens.')).toBeVisible();
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      all: true,
      dryRun: false,
    });
  });

  it('[IAM-007] says when nothing matches instead of asking to confirm', async () => {
    const user = userEvent.setup();
    const { region } = await openPage({
      'POST /admin/tokens/revoke': () => jsonResponse(200, { matched: 0 }),
    });
    const bulk = region('Revoke in bulk');
    await user.click(bulk.getByRole('radio', { name: 'Every token' }));
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    expect(await bulk.findByText('No active token matches.')).toBeVisible();
    expect(bulk.queryByRole('button', { name: 'Confirm revocation' })).toBeNull();
  });

  it('[IAM-007] saves a longest lifetime beyond a year and the reminder window', async () => {
    const user = userEvent.setup();
    const { calls, region } = await openPage();
    const policy = region('Token policy');
    const max = policy.getByLabelText('Longest lifetime (days)');
    expect(max).toHaveValue(365);
    expect(max).toHaveAttribute('max', '3650');
    await user.clear(max);
    await user.type(max, '730');
    await user.clear(policy.getByLabelText('Rotation reminder (days before expiry)'));
    await user.type(policy.getByLabelText('Rotation reminder (days before expiry)'), '21');
    await user.click(policy.getByRole('button', { name: 'Save policy' }));
    expect(await policy.findByText('Policy saved.')).toHaveAttribute('role', 'status');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      maxLifetimeDays: 730,
      reminderDays: 21,
    });
  });

  it('[IAM-007] reports a policy the backend refuses', async () => {
    const user = userEvent.setup();
    const { region } = await openPage({
      'PUT /admin/token-policy': () => jsonResponse(400, { error: 'invalid_request' }),
    });
    const policy = region('Token policy');
    await user.click(policy.getByRole('button', { name: 'Save policy' }));
    expect(await policy.findByRole('alert')).toHaveTextContent(
      'The policy could not be saved. Check the numbers and try again.',
    );
  });

  it('[IAM-007] is for site administrators only', async () => {
    const calls = stubBackend({});
    window.location.hash = '#/admin/tokens';
    render(<App session={MEMBER} />);
    expect(await screen.findByText('Only site administrators can see every token.')).toBeVisible();
    expect(calls.filter((c) => c.path.startsWith('/admin'))).toEqual([]);
  });

  it('[IAM-007] turns away a session that lost its administrator rights', async () => {
    stubBackend({ '*': () => jsonResponse(403, { error: 'forbidden' }) });
    window.location.hash = '#/admin/tokens';
    render(<App session={ADMIN} />);
    expect(await screen.findByText('Only site administrators can see every token.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Revoke in bulk' })).toBeNull();
  });

  it('[IAM-007] is reachable from Administration and the command palette', async () => {
    const user = userEvent.setup();
    inventoryBackend();
    window.location.hash = '#/admin';
    render(<App session={ADMIN} />);
    expect(await screen.findByRole('link', { name: 'API tokens' })).toHaveAttribute(
      'href',
      '#/admin/tokens',
    );
    expect(screen.getByRole('link', { name: 'Service accounts' })).toHaveAttribute(
      'href',
      '#/admin/service-accounts',
    );
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('revoke');
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/admin/tokens');
  });

  it('[IAM-007] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const { tokens, region } = await openPage();
    expect(items(tokens)).toHaveLength(8);
    expect(region('Revoke in bulk').getByRole('button', { name: 'Revoke tokens' })).toBeVisible();
  });
});

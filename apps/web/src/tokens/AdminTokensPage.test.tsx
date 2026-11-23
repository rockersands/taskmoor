import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { type Handler, noContent, stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { useTimeZone } from '../test/timeZone';
import { setViewportWidth } from '../test/viewport';
import { AdminTokensPage } from './AdminTokensPage';
import type { AdminTokensClient, ApiToken, BulkCriteria, TokenPolicy } from './client';
import {
  fakeAdminTokensClient,
  inventoryTokens,
  LIMITS,
  manyTokens,
  ownersOf,
  POLICY,
  sampleToken,
} from './fixtures';

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

async function openPage(extra: Record<string, Handler> = {}, session: Session = ADMIN) {
  const calls = inventoryBackend(extra);
  window.location.hash = '#/admin/tokens';
  render(<App session={session} />);
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

  it('[IAM-007] with no token at all, offers no filter and no count over the empty state', async () => {
    const none = () => jsonResponse(200, { tokens: [], total: 0, owners: [] });
    inventoryBackend({
      'GET /admin/tokens?status=all&limit=500': none,
      'GET /admin/tokens?status=active&limit=1': none,
    });
    window.location.hash = '#/admin/tokens';
    render(<App session={ADMIN} />);
    const tokens = within(await screen.findByRole('region', { name: 'Tokens' }));
    expect(await tokens.findByText('No API tokens yet')).toBeVisible();
    expect(tokens.queryByLabelText('Show')).toBeNull();
    expect(tokens.queryByText('0 tokens')).toBeNull();
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
    // Revoking asks first and says what happens (D13, AD-16).
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const asked = tokens.getByRole('group', { name: /Revoke Sync job of River Stone\?/ });
    expect(within(asked).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // The way back gives the focus to the token's Revoke button again, not to the page.
    await user.keyboard('{Escape}');
    expect(tokens.getByRole('button', { name: 'Revoke Sync job of River Stone' })).toHaveFocus();
    await user.click(tokens.getByRole('button', { name: 'Revoke Sync job of River Stone' }));
    const confirm = tokens.getByRole('group', { name: /Revoke Sync job of River Stone\?/ });
    await user.click(
      within(confirm).getByRole('button', { name: 'Revoke Sync job of River Stone' }),
    );
    expect(await tokens.findByText('Revoked Sync job of River Stone.')).toHaveAttribute(
      'role',
      'status',
    );
    // The revoked token's button is gone: the list's heading keeps the focus.
    expect(tokens.getByRole('heading', { name: 'Tokens' })).toHaveFocus();
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
    // It asks as every destructive action does (D13): the focus on Cancel, the safe choice.
    const question = bulk.getByRole('group', { name: /^This revokes 3 active tokens\./ });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const confirm = within(question).getByRole('button', { name: 'Confirm revocation' });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/admin/tokens/revoke', body: { ownerId: 1, dryRun: true } },
    ]);
    await user.click(confirm);
    expect(await bulk.findByText('Revoked 3 tokens.')).toHaveAttribute('role', 'status');
    // The question is answered: the focus goes back to Revoke tokens.
    expect(bulk.getByRole('button', { name: 'Revoke tokens' })).toHaveFocus();
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
    await user.click(bulk.getByRole('radio', { name: 'Tokens created before a date' }));
    await user.type(bulk.getByLabelText('Created before'), day);
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    await bulk.findByRole('button', { name: 'Confirm revocation' });
    const preview = calls.filter((c) => c.method === 'POST').at(-1)?.body as {
      createdBefore: string;
    };
    expect(new Date(preview.createdBefore).getTime()).toBe(new Date(`${day}T00:00:00`).getTime());
    await user.click(bulk.getByRole('button', { name: 'Cancel' }));
    expect(bulk.queryByRole('button', { name: 'Confirm revocation' })).toBeNull();
    expect(bulk.getByRole('button', { name: 'Revoke tokens' })).toHaveFocus();
    // Escape goes back the same way.
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    await bulk.findByRole('button', { name: 'Confirm revocation' });
    await user.keyboard('{Escape}');
    expect(bulk.queryByRole('button', { name: 'Confirm revocation' })).toBeNull();
    expect(bulk.getByRole('button', { name: 'Revoke tokens' })).toHaveFocus();

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

describe('the token inventory past the first page (T-308)', () => {
  const renderPage = (client: AdminTokensClient) => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={ADMIN}>
          <main>
            <AdminTokensPage client={client} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    return within(screen.getByRole('region', { name: 'Tokens' }));
  };
  const names = (tokens: ReturnType<typeof within>) =>
    items(tokens).map((li) => li.querySelector('.token-name span')?.textContent);
  const old = sampleToken({ id: 90, name: 'Old laptop', status: 'revoked' });

  it('[IAM-007] counts every token and shows the rest a page at a time', async () => {
    const user = userEvent.setup();
    const tokens = renderPage(fakeAdminTokensClient({}, { tokens: manyTokens(7), pageSize: 3 }));
    expect(await tokens.findByText('7 tokens')).toBeVisible();
    expect(names(tokens)).toEqual(['Token 001', 'Token 002', 'Token 003']);
    // Each page starts at the last token shown, to see that the list did not move.
    await user.click(tokens.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(items(tokens)).toHaveLength(5));
    await user.click(tokens.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(items(tokens)).toHaveLength(7));
    expect(names(tokens).at(-1)).toBe('Token 007');
    expect(tokens.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(tokens.getByText('7 tokens')).toBeVisible();
  });

  it('[IAM-007] another filter after Show more starts afresh, and the late page is dropped', async () => {
    const user = userEvent.setup();
    const base = fakeAdminTokensClient({}, { tokens: [...manyTokens(5), old], pageSize: 2 });
    let release = () => {};
    const tokens = renderPage({
      ...base,
      list: async (filter, offset = 0) => {
        const answer = await base.list(filter, offset);
        // The second page of every token arrives only after the revoked ones have been listed.
        if (filter === 'all' && offset > 0) await new Promise<void>((done) => (release = done));
        return answer;
      },
    });
    await tokens.findByText('6 tokens');
    await user.click(tokens.getByRole('button', { name: 'Show more' }));
    // Not disabled, so the focus stays on it.
    expect(tokens.getByRole('button', { name: 'Show more' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.selectOptions(tokens.getByLabelText('Show'), 'revoked');
    expect(await tokens.findByText('1 token')).toBeVisible();
    expect(names(tokens)).toEqual(['Old laptop']);
    release();
    await new Promise((settle) => setTimeout(settle, 20));
    expect(names(tokens)).toEqual(['Old laptop']);
    expect(tokens.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('[IAM-007] a revocation keeps the pages Show more opened', async () => {
    const user = userEvent.setup();
    const tokens = renderPage(fakeAdminTokensClient({}, { tokens: manyTokens(7), pageSize: 3 }));
    await tokens.findByText('7 tokens');
    await user.click(tokens.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(items(tokens)).toHaveLength(5));
    await user.click(tokens.getByRole('button', { name: 'Revoke Token 004 of River Stone' }));
    const confirm = tokens.getByRole('group', { name: /Revoke Token 004 of River Stone\?/ });
    await user.click(
      within(confirm).getByRole('button', { name: 'Revoke Token 004 of River Stone' }),
    );
    expect(await tokens.findByText('Revoked Token 004 of River Stone.')).toBeVisible();
    await waitFor(() =>
      expect(tokens.queryByRole('button', { name: 'Revoke Token 004 of River Stone' })).toBeNull(),
    );
    expect(names(tokens)).toEqual([
      'Token 001',
      'Token 002',
      'Token 003',
      'Token 004',
      'Token 005',
    ]);
    expect(tokens.getByRole('button', { name: 'Show more' })).toBeVisible();
  });

  it('[IAM-007] skips no token when one ahead leaves the list, and the focus goes to the last page', async () => {
    const user = userEvent.setup();
    const base = fakeAdminTokensClient();
    let live = manyTokens(7);
    const tokens = renderPage({
      ...base,
      list: async (_filter, offset = 0) => ({
        tokens: structuredClone(live.slice(offset, offset + 3)),
        total: live.length,
        owners: [],
      }),
    });
    await tokens.findByText('7 tokens');
    // Token 002 expires, or its owner revokes it, meanwhile: it leaves the Active list.
    live = live.filter((token) => token.name !== 'Token 002');
    const more = () => tokens.getByRole('button', { name: 'Show more' });
    more().focus();
    await user.keyboard('{Enter}');
    expect(await tokens.findByText('6 tokens')).toBeVisible();
    expect(names(tokens)).toEqual([
      'Token 001',
      'Token 003',
      'Token 004',
      'Token 005',
      'Token 006',
    ]);
    expect(more()).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(items(tokens)).toHaveLength(6));
    expect(names(tokens).at(-1)).toBe('Token 007');
    // The last page: the button goes, and the focus is on the token it brought.
    expect(tokens.queryByRole('button', { name: 'Show more' })).toBeNull();
    await waitFor(() => expect(tokens.getByText('Token 007').closest('li')).toHaveFocus());
  });
});

/**
 * One clock per person (T-280): the day tokens were created before starts at midnight on the
 * account's zone, whatever the device's. The device here is New York.
 */
describe('admin token inventory on the account’s clock', () => {
  useTimeZone('America/New_York');
  const admin = ADMIN as Extract<Session, { status: 'signed-in' }>;

  it('[IAM-007] [NFR-006] revokes tokens created before the start of a day on the account’s zone', async () => {
    const user = userEvent.setup();
    const { calls, region } = await openPage(
      {},
      { status: 'signed-in', user: { ...admin.user, timeZone: 'Europe/Madrid' } },
    );
    const bulk = region('Revoke in bulk');
    await user.click(bulk.getByRole('radio', { name: 'Tokens created before a date' }));
    await user.type(bulk.getByLabelText('Created before'), '2026-11-16');
    await user.click(bulk.getByRole('button', { name: 'Revoke tokens' }));
    // Midnight in Madrid (UTC+1) is 23:00 the day before in UTC, not New York's 05:00.
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
        createdBefore: '2026-11-15T23:00:00.000Z',
        dryRun: true,
      }),
    );
  });
});

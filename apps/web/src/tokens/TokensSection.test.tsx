import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SIGNED_IN, sampleSessions } from '../account/fixtures';
import { ADMIN } from '../admin/fixtures';
import type { Session } from '../session/SessionProvider';
import { type Handler, noContent, stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { ApiToken, TokenPolicy } from './client';
import { POLICY, personalTokens, sampleToken } from './fixtures';

const SECRET = 'tmk_EXAMPLE_ONLY_not_a_real_token_000042';

function tokensAnswer(tokens: ApiToken[] = personalTokens(), policy: TokenPolicy = POLICY) {
  return () => jsonResponse(200, { tokens, policy });
}

async function openTokens(handlers: Record<string, Handler> = {}, session: Session = SIGNED_IN) {
  const calls = stubBackend({
    'GET /sessions': () => jsonResponse(200, { sessions: sampleSessions() }),
    'GET /account/tokens': tokensAnswer(),
    ...handlers,
  });
  window.location.hash = '#/account';
  render(<App session={session} />);
  const section = await screen.findByRole('region', { name: 'API tokens' });
  return { calls, section: within(section) };
}

describe('API tokens on the Account page', () => {
  it('[IAM-007] lists each token with status, scopes, last use and expiry', async () => {
    const { section } = await openTokens();
    const list = await section.findByRole('list', { name: 'Your API tokens' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    const [deploy, weekly, editor, laptop, trial] = items as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(deploy).toHaveTextContent('Deploy script');
    expect(deploy).toHaveTextContent('Active');
    expect(deploy).toHaveTextContent('Scopes: Read and Write');
    expect(deploy).toHaveTextContent(/Last used/);
    expect(deploy).toHaveTextContent(/Expires [A-Z][a-z]{2} \d+, \d{4}/);
    expect(within(deploy).getByRole('button', { name: 'Revoke Deploy script' })).toBeVisible();
    // Due for rotation within the reminder window: flagged.
    expect(within(weekly).getByText('Expires in 5 days')).toHaveClass('status-warn');
    expect(editor).toHaveTextContent('Never used');
    expect(laptop).toHaveTextContent('Revoked');
    expect(within(laptop).queryByRole('button')).toBeNull();
    expect(trial).toHaveTextContent('Expired');
    expect(within(trial).queryByRole('button')).toBeNull();
  });

  it('[IAM-007] creates a token with a name, scopes and an expiry and shows it once', async () => {
    const user = userEvent.setup();
    let tokens = personalTokens();
    const { calls, section } = await openTokens({
      'GET /account/tokens': () => jsonResponse(200, { tokens, policy: POLICY }),
      'POST /account/tokens': (body) => {
        const input = body as { name: string; scopes: ApiToken['scopes'] };
        const apiToken = sampleToken({ id: 99, name: input.name, scopes: input.scopes });
        tokens = [apiToken, ...tokens];
        return jsonResponse(201, { token: SECRET, apiToken });
      },
    });
    await section.findByRole('list', { name: 'Your API tokens' });
    await user.type(section.getByLabelText('Token name'), 'Release notes bot');
    await user.click(section.getByRole('checkbox', { name: 'Write' }));
    await user.selectOptions(section.getByLabelText('Expires after'), '90');
    await user.click(section.getByRole('button', { name: 'Create token' }));

    const secret = await section.findByLabelText('New token');
    expect(secret).toHaveValue(SECRET);
    expect(secret).toHaveAttribute('readonly');
    expect(secret).toHaveFocus();
    expect(
      section.getByRole('heading', { name: 'Copy the new token Release notes bot' }),
    ).toBeVisible();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/account/tokens',
      body: { name: 'Release notes bot', scopes: ['read', 'write'], expiresInDays: 90 },
    });
    // The form is ready for the next one; the list shows the new token, never its value.
    expect(section.getByLabelText('Token name')).toHaveValue('');
    await waitFor(() =>
      expect(within(section.getByRole('list')).getAllByRole('listitem')).toHaveLength(6),
    );
    expect(section.getByRole('list')).not.toHaveTextContent(SECRET);

    await user.click(section.getByRole('button', { name: 'Done' }));
    expect(section.queryByLabelText('New token')).toBeNull();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    expect(section.getByRole('heading', { level: 2, name: 'API tokens' })).toHaveFocus();
  });

  it('[IAM-007] copies the new token to the clipboard, or asks to copy it by hand', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    const { section } = await openTokens({
      'POST /account/tokens': () =>
        jsonResponse(201, { token: SECRET, apiToken: sampleToken({ id: 99, name: 'CLI' }) }),
    });
    await section.findByRole('list');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.type(section.getByLabelText('Token name'), 'CLI');
    await user.click(section.getByRole('button', { name: 'Create token' }));
    await user.click(await section.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(await section.findByText('Copied to the clipboard.')).toHaveAttribute('role', 'status');

    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(section.getByRole('button', { name: 'Copy' }));
    expect(await section.findByRole('alert')).toHaveTextContent('copy it yourself');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });

  it('[IAM-007] offers the administration scope to site administrators only', async () => {
    const first = await openTokens();
    await first.section.findByRole('list');
    expect(first.section.getAllByRole('checkbox')).toHaveLength(2);
    expect(first.section.queryByRole('checkbox', { name: 'Administration' })).toBeNull();
    expect(first.section.getByRole('checkbox', { name: 'Read' })).toBeChecked();
  });

  it('[IAM-007] shows the administration scope to an administrator', async () => {
    const { section } = await openTokens({}, ADMIN);
    await section.findByRole('list');
    expect(section.getByRole('checkbox', { name: 'Administration' })).not.toBeChecked();
    expect(section.getByText(/Use administrator rights/)).toBeVisible();
    // Provisioning tokens belong to service accounts, never to a person (ADR-038).
    expect(section.queryByRole('checkbox', { name: 'SCIM provisioning' })).toBeNull();
  });

  it('[IAM-007] offers the administration scope to whoever the server allows it', async () => {
    // A configuration administrator is not a site administrator, and may still hold it.
    const { section } = await openTokens({
      'GET /account/tokens': () =>
        jsonResponse(200, { tokens: personalTokens(), policy: POLICY, adminScopeAllowed: true }),
    });
    await section.findByRole('list');
    expect(section.getByRole('checkbox', { name: 'Administration' })).not.toBeChecked();
  });

  it('[IAM-007] offers lifetimes up to the policy maximum, also past a year', async () => {
    const short = await openTokens({
      'GET /account/tokens': tokensAnswer([], { maxLifetimeDays: 45, reminderDays: 7 }),
    });
    await short.section.findByText('You have no API tokens.');
    const options = within(short.section.getByLabelText('Expires after')).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['7', '30', '45']);
    expect(short.section.getByLabelText('Expires after')).toHaveValue('30');
    expect(short.section.getByText('Tokens last at most 45 days on this instance.')).toBeVisible();
  });

  it('[IAM-007] lists two-year lifetimes when the administrator allows them', async () => {
    const { section } = await openTokens({
      'GET /account/tokens': tokensAnswer([], { maxLifetimeDays: 730, reminderDays: 14 }),
    });
    await section.findByText('You have no API tokens.');
    const select = section.getByLabelText('Expires after');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['7', '30', '60', '90', '180', '365', '730']);
    expect(within(select).getByRole('option', { name: /^730 days \(on / })).toBeInTheDocument();
  });

  it('[IAM-007] explains a refused expiry and a missing scope', async () => {
    const user = userEvent.setup();
    const { calls, section } = await openTokens({
      'POST /account/tokens': () =>
        jsonResponse(400, { error: 'expiry_too_long', maxLifetimeDays: 30 }),
    });
    await section.findByRole('list');
    await user.type(section.getByLabelText('Token name'), 'Long one');
    await user.click(section.getByRole('checkbox', { name: 'Read' }));
    await user.click(section.getByRole('button', { name: 'Create token' }));
    expect(await section.findByRole('alert')).toHaveTextContent('Choose at least one scope.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.click(section.getByRole('checkbox', { name: 'Read' }));
    await user.selectOptions(section.getByLabelText('Expires after'), '365');
    await user.click(section.getByRole('button', { name: 'Create token' }));
    const alert = await section.findByRole('alert');
    expect(alert).toHaveTextContent('Tokens may last at most 30 days.');
    expect(section.getByLabelText('Expires after')).toHaveAttribute('aria-invalid', 'true');
    expect(section.getByLabelText('Expires after').getAttribute('aria-describedby')).toContain(
      alert.id,
    );
    // Nothing was shown, so nothing can leak.
    expect(section.queryByLabelText('New token')).toBeNull();
  });

  it('[IAM-007] revokes a token and keeps it listed as revoked', async () => {
    const user = userEvent.setup();
    let tokens = personalTokens();
    const { calls, section } = await openTokens({
      'GET /account/tokens': () => jsonResponse(200, { tokens, policy: POLICY }),
      'DELETE /account/tokens/41': () => {
        tokens = tokens.map((t) =>
          t.id === 41 ? { ...t, status: 'revoked', revokedAt: new Date().toISOString() } : t,
        );
        return noContent();
      },
    });
    await user.click(await section.findByRole('button', { name: 'Revoke Deploy script' }));
    expect(await section.findByText('Revoked Deploy script.')).toHaveAttribute('role', 'status');
    await waitFor(() =>
      expect(section.queryByRole('button', { name: 'Revoke Deploy script' })).toBeNull(),
    );
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/account/tokens/41')).toBe(true);
    expect(section.getByRole('heading', { level: 2, name: 'API tokens' })).toHaveFocus();
  });

  it('[IAM-007] reports a failed revocation and a list that could not be read', async () => {
    const user = userEvent.setup();
    const first = await openTokens({
      'DELETE /account/tokens/41': () => jsonResponse(500, { error: 'boom' }),
    });
    await user.click(await first.section.findByRole('button', { name: 'Revoke Deploy script' }));
    expect(await first.section.findByRole('alert')).toHaveTextContent(
      'The token could not be revoked. Try again in a moment.',
    );
  });

  it('[IAM-007] says when the tokens could not be read', async () => {
    const { section } = await openTokens({
      'GET /account/tokens': () => jsonResponse(500, { error: 'boom' }),
    });
    expect(await section.findByRole('alert')).toHaveTextContent(
      'Your tokens could not be read. Try again in a moment.',
    );
  });

  it('[IAM-007] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const { section } = await openTokens();
    expect(await section.findAllByRole('listitem')).toHaveLength(5);
    expect(section.getByRole('button', { name: 'Create token' })).toBeVisible();
    expect(section.getByLabelText('Token name')).toBeVisible();
  });
});

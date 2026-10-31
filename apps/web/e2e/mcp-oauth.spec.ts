import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * An MCP client's OAuth sign-in in a real browser (M1-072; API-002 (3); ADR-084): the client
 * registers itself, the browser of a signed-in person goes through authorize to the consent
 * page, and the person's answer sends it back to the client's loopback address with a code, or
 * with `access_denied`. It uses the attachments database (preview 4174) and its administrator.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const CALLBACK = 'http://127.0.0.1:33418/callback';

test('[API-002] a person approves an MCP client on the consent page', async ({ page }) => {
  const signIn = await page.request.post(`${BASE}/api/v1/session`, { data: ADMIN });
  expect(signIn.status()).toBe(200);
  const registered = await page.request.post(`${BASE}/api/v1/oauth/register`, {
    data: { client_name: 'E2E assistant', redirect_uris: [CALLBACK] },
  });
  expect(registered.status()).toBe(201);
  const clientId = (await registered.json()).client_id as string;

  // The client's loopback listener: the browser lands here with the answer.
  const landed: string[] = [];
  await page.route('http://127.0.0.1:33418/**', (route) => {
    landed.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'You may close this.' });
  });

  const authorize = (state: string) => {
    const verifier = randomBytes(32).toString('base64url');
    return `${BASE}/api/v1/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'read write',
      state,
    })}`;
  };

  await page.goto(authorize('first'));
  await expect(
    page.getByRole('heading', { name: 'Allow E2E assistant to use Taskmoor?' }),
  ).toBeVisible();
  await expect(page.getByText('You go back to an app on this computer.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Also let it make changes' }).uncheck();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect.poll(() => landed.length).toBe(1);
  const approved = new URL(landed[0] as string);
  expect(approved.searchParams.get('state')).toBe('first');
  expect(approved.searchParams.get('code')).toBeTruthy();

  await page.goto(authorize('second'));
  await page.getByRole('button', { name: 'Don’t allow' }).click();
  await expect.poll(() => landed.length).toBe(2);
  const refused = new URL(landed[1] as string);
  expect(refused.searchParams.get('error')).toBe('access_denied');
  expect(refused.searchParams.get('state')).toBe('second');
});

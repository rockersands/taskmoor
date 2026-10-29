import { randomBytes } from 'node:crypto';
import { expect, request, test } from '@playwright/test';

/**
 * The inbox end to end (M1-058; NTF-003, NTF-005): with Bea's inbox open, Ada mentions her in
 * a comment; the item must show within a second of the comment being written, and the mention
 * must notify her exactly once, also after Ada edits the comment. It uses the attachments
 * database (preview 4174), where the API server runs the worker's event loop with its usual idle
 * wait, so the time measured includes the relay, the notification subscriber and the socket.
 */
const BASE = 'http://localhost:4174';
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };

test('[NTF-003] [NTF-005] a mention reaches the open inbox within a second, exactly once', async ({
  page,
}, testInfo) => {
  const ada = await request.newContext({ baseURL: BASE });
  expect((await ada.post('/api/v1/session', { data: ADMIN })).status()).toBe(200);
  // Bea, a Member of the ATT track; her password is made for this run.
  const project = testInfo.project.name;
  const bea = {
    email: `bea-${project}-${Date.now()}@attach.test`,
    name: `Bea ${project}`,
    password: `bea-${randomBytes(18).toString('base64url')}`,
  };
  const created = await ada.post('/api/v1/users', { data: bea });
  expect(created.status(), await created.text()).toBe(201);
  const beaId = (await created.json()).user.id as number;
  const roles = (await (await ada.get('/api/v1/roles')).json()).roles as {
    id: number;
    name: string;
  }[];
  const members = roles.find((r) => r.name === 'Members')?.id;
  const track = (await (await ada.get('/api/v1/tracks/ATT')).json()).track.id as number;
  expect(
    (await ada.put(`/api/v1/tracks/${track}/roles/${members}/users/${beaId}`)).status(),
  ).toBeLessThan(300);
  const ticket = await ada.post('/api/v1/tickets', {
    data: { track: 'ATT', summary: `Mention test on ${project}` },
  });
  expect(ticket.status()).toBe(201);
  const key = (await ticket.json()).ticket.key as string;

  // Bea's inbox, open, its realtime socket connected.
  expect(
    (
      await page.request.post(`${BASE}/api/v1/session`, {
        data: { email: bea.email, password: bea.password },
      })
    ).status(),
  ).toBe(200);
  const inboxFrame = new Promise<void>((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        if (String(frame.payload).includes('"inbox"')) resolve();
      });
    });
  });
  await page.goto(`${BASE}/#/inbox`);
  const inbox = page.getByRole('region', { name: 'Inbox' });
  await expect(
    inbox.getByText('Nothing here. Mentions and changes to tickets you follow arrive here.'),
  ).toBeVisible();
  await inboxFrame;

  // Ada mentions her; the clock runs from the comment being written.
  const body = (text: string) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { id: String(beaId), label: bea.name } },
          { type: 'text', text },
        ],
      },
    ],
  });
  const item = inbox
    .getByRole('listitem')
    .filter({ hasText: 'Ada Attach mentioned you in a comment' });
  const started = Date.now();
  const comment = await ada.post(`/api/v1/tickets/${key}/comments`, {
    data: { body: body(' can you check the totals?') },
  });
  expect(comment.status()).toBe(201);
  expect((await comment.json()).mentionWarnings).toBeUndefined();
  await item.waitFor({ state: 'visible', timeout: 5000 });
  const elapsed = Date.now() - started;
  testInfo.annotations.push({ type: 'inbox latency (ms)', description: String(elapsed) });
  expect(elapsed).toBeLessThan(1000);
  await expect(item).toContainText(key);
  await expect(item).toContainText('can you check the totals?');

  // Exactly once: nothing more arrives, and an edit that keeps the mention adds nothing.
  const commentId = (await comment.json()).comment.id as number;
  const edited = await ada.patch(`/api/v1/tickets/${key}/comments/${commentId}`, {
    data: { body: body(' can you check the totals and the tax?') },
  });
  expect(edited.status()).toBe(200);
  await page.waitForTimeout(1500);
  const mentions = (await (await page.request.get(`${BASE}/api/v1/inbox?event=mentioned`)).json())
    .items as { ticket: { key: string } }[];
  expect(mentions.filter((m) => m.ticket.key === key)).toHaveLength(1);
  await expect(item).toHaveCount(1);

  // Read from the inbox; nothing scrolls sideways, on a phone either.
  await item.getByRole('button', { name: `Mark ${key} as read` }).click();
  await expect(item.getByRole('button', { name: `Mark ${key} as unread` })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ada.dispose();
});

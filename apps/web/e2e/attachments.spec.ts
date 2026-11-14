import { readFile } from 'node:fs/promises';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

/**
 * Attachments end to end (M1-016, CORE-021): upload through the page, preview, download,
 * download all, delete, on both stores. The API server serves one attachments database twice:
 * through the preview on 4174 with files on local disk, through 4175 with files in an
 * S3-compatible bucket, where downloads are redirects to signed URLs. Its administrator and
 * the ATT track are made by the API server; each test makes its own ticket.
 */
const ADMIN = { email: 'ada@attach.test', password: process.env.TASKMOOR_E2E_ATTACH_PASSWORD };
const BACKENDS = [
  { name: 'local disk', base: 'http://localhost:4174' },
  { name: 'S3', base: 'http://localhost:4175' },
] as const;

/** A 2 x 2 PNG, made here. */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.from([0, 245, 184, 150, 161, 69, 42, 0, 161, 69, 42, 245, 184, 150]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A one-entry ZIP (deflated), enough to browse. */
function tinyZip(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const body = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + body.length, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}

async function signIn(request: APIRequestContext, base: string): Promise<void> {
  const res = await request.post(`${base}/api/v1/session`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(res.status()).toBe(200);
}

async function newTicket(request: APIRequestContext, base: string, summary: string) {
  const res = await request.post(`${base}/api/v1/tickets`, { data: { track: 'ATT', summary } });
  expect(res.status()).toBe(201);
  return (await res.json()).ticket as { id: number; key: string };
}

async function downloaded(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const download = await pending;
  return {
    name: download.suggestedFilename(),
    body: await readFile((await download.path()) as string),
  };
}

for (const backend of BACKENDS) {
  test(`[CORE-021] uploads, previews, downloads and deletes attachments on ${backend.name}`, async ({
    page,
  }) => {
    await signIn(page.request, backend.base);
    const ticket = await newTicket(page.request, backend.base, `Files on ${backend.name}`);
    await page.goto(`${backend.base}/#/tickets/${ticket.key}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `${ticket.key} Files on ${backend.name}`,
    );
    const panel = page.getByRole('region', { name: 'Attachments' });
    await expect(panel.getByText('No files attached yet.')).toBeVisible();

    // Upload through the file chooser: text, an image and a ZIP.
    const notes = `Steps to reproduce on ${backend.name}.\nRésumé: it breaks.\n`;
    await page.getByLabel('Attach files').setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(notes) },
      { name: 'screenshot.png', mimeType: 'image/png', buffer: tinyPng() },
      { name: 'logs.zip', mimeType: 'application/zip', buffer: tinyZip('app.log', 'boot ok') },
    ]);
    await expect(
      panel.getByText('notes.txt attached. screenshot.png attached. logs.zip attached.'),
    ).toBeVisible();
    await expect(panel.getByText('3 attachments')).toBeVisible();

    // Download: the same bytes under the same name, through the API or a signed URL.
    const file = await downloaded(page, () =>
      panel.getByRole('link', { name: 'Download notes.txt' }).click(),
    );
    expect(file.name).toBe('notes.txt');
    expect(file.body.toString('utf8')).toBe(notes);

    // Previews: the text, the picture, the ZIP's entries.
    await panel.getByRole('button', { name: 'Preview notes.txt' }).click();
    const textDialog = page.getByRole('dialog', { name: 'notes.txt' });
    await expect(textDialog.getByText('Résumé: it breaks.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(textDialog).toBeHidden();

    await panel.getByRole('button', { name: 'Preview screenshot.png' }).click();
    const picture = page.getByRole('dialog', { name: 'screenshot.png' }).getByRole('img');
    await expect(picture).toBeVisible();
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
    await page.getByRole('button', { name: 'Close the preview' }).click();

    await panel.getByRole('button', { name: 'Preview logs.zip' }).click();
    const zipDialog = page.getByRole('dialog', { name: 'logs.zip' });
    const entry = await downloaded(page, () =>
      zipDialog.getByRole('link', { name: 'Download app.log' }).click(),
    );
    expect([entry.name, entry.body.toString()]).toEqual(['app.log', 'boot ok']);
    await page.keyboard.press('Escape');

    // Everything at once.
    const all = await downloaded(page, () =>
      panel.getByRole('link', { name: 'Download all as ZIP' }).click(),
    );
    expect(all.name).toBe(`${ticket.key}-attachments.zip`);
    expect(all.body.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');

    // Delete, confirmed.
    await panel.getByRole('button', { name: 'Delete notes.txt' }).click();
    await panel
      .getByRole('group', { name: 'Delete notes.txt for good?' })
      .getByRole('button', { name: 'Delete notes.txt' })
      .click();
    await expect(panel.getByText('notes.txt deleted.')).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Download notes.txt' })).toBeHidden();
    await expect(panel.getByText('2 attachments')).toBeVisible();
  });
}

test('[CORE-021] takes files dropped on the panel or pasted into it, and refuses one over the limit', async ({
  page,
}) => {
  const { base } = BACKENDS[0];
  await signIn(page.request, base);
  const ticket = await newTicket(page.request, base, 'Drop and paste');
  await page.goto(`${base}/#/tickets/${ticket.key}`);
  const zone = page.getByRole('region', { name: 'Attachments' });
  await expect(page.getByLabel('Attach files')).toBeAttached();

  const dropped = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['dropped bytes'], 'dropped.txt', { type: 'text/plain' }));
    return transfer;
  });
  await zone.dispatchEvent('drop', { dataTransfer: dropped });
  await expect(page.getByText('dropped.txt attached.')).toBeVisible();

  // Keyboard users focus the file chooser and paste; the panel takes the files.
  await page.getByLabel('Attach files').focus();
  await page.getByLabel('Attach files').evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['pasted bytes'], 'image.png', { type: 'image/png' }));
    // A plain event carrying the data: Firefox drops the clipboardData given to new ClipboardEvent.
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: transfer });
    element.dispatchEvent(paste);
  });
  await expect(page.getByText(/^pasted-.*\.png attached\.$/)).toBeVisible();

  // CORE-021 (1): over the limit, refused with a clear message (here before it is sent).
  const settings = await page.request.put(`${base}/api/v1/admin/attachment-settings`, {
    data: { maxFileSize: 1000 },
  });
  expect(settings.status()).toBe(200);
  try {
    await page.reload();
    await page.getByLabel('Attach files').setInputFiles({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(2500, 1),
    });
    await expect(page.getByRole('alert')).toHaveText(
      'big.bin is larger than the 1,000 B limit for one file.',
    );
    // And by the API when a client sends it anyway.
    const refused = await page.request.post(`${base}/api/v1/tickets/${ticket.id}/attachments`, {
      multipart: {
        file: { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2500) },
      },
    });
    expect(refused.status()).toBe(413);
    expect(await refused.json()).toEqual({ error: 'file_too_large', maxFileSize: 1000 });
  } finally {
    await page.request.put(`${base}/api/v1/admin/attachment-settings`, {
      data: { maxFileSize: 1024 ** 3 },
    });
  }
});

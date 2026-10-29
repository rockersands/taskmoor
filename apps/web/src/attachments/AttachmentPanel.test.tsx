import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { type Handler, noContent, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { Attachment } from './client';
import { ATTACHMENTS, SERVER_LOG, ZIP_LISTING } from './fixtures';

const TICKET = { id: 41, key: 'SHOP-41', summary: 'Checkout fails for expired cards' };

function openTicket(
  handlers: Record<string, Handler> = {},
  list: { attachments?: Attachment[]; maxFileSize?: number; canCreate?: boolean } = {},
) {
  const calls = stubBackend({
    'GET /tickets/SHOP-41': () => jsonResponse(200, { ticket: TICKET }),
    'GET /tickets/41/attachments': () =>
      jsonResponse(200, {
        attachments: list.attachments ?? ATTACHMENTS,
        maxFileSize: list.maxFileSize ?? 1024 ** 3,
        canCreate: list.canCreate ?? true,
        available: true,
      }),
    // The page's comments (M1-018): none here.
    'GET /tickets/41/comments?limit=100': () =>
      jsonResponse(200, {
        comments: [],
        next: null,
        can: { add: false, react: false },
        lock: null,
      }),
    ...handlers,
  });
  window.location.hash = '#/tickets/SHOP-41';
  render(<App session={MEMBER} />);
  return calls;
}

const panel = () => screen.getByRole('region', { name: 'Attachments' });
const uploaded = (name: string, id = 99): Attachment => ({
  ...(ATTACHMENTS[2] as Attachment),
  id,
  name,
  canDelete: true,
});

describe('the attachment panel (M1-016)', () => {
  it('[CORE-021] lists the files with size, uploader and date, and links each download', async () => {
    openTicket();
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'SHOP-41 Checkout fails for expired cards',
      }),
    ).toBeVisible();
    const items = await within(panel()).findAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(within(panel()).getByText('6 attachments')).toBeVisible();
    const first = items[0] as HTMLElement;
    expect(
      within(first).getByRole('link', { name: 'Download checkout-error.png' }),
    ).toHaveAttribute('href', '/api/v1/tickets/41/attachments/11/content');
    expect(within(first).getByText(/^178\.1 KB · Ada Lovelace · /)).toBeVisible();
    // The thumbnail is decoration: the name says what it is.
    expect(first.querySelector('img')).toHaveAttribute(
      'src',
      '/api/v1/tickets/41/attachments/11/thumbnail',
    );
    expect(within(panel()).getByRole('link', { name: 'Download all as ZIP' })).toHaveAttribute(
      'href',
      '/api/v1/tickets/41/attachments/archive',
    );
    // Files not cleared by the scan neither download nor preview.
    const pending = items[4] as HTMLElement;
    expect(within(pending).queryByRole('link')).toBeNull();
    expect(within(pending).getByText('Being checked for viruses')).toBeVisible();
    expect(within(items[5] as HTMLElement).getByText('Blocked: a virus was found')).toBeVisible();
    expect(within(items[5] as HTMLElement).getByText(/^80 KB · /)).toBeVisible();
    // Delete where allowed only.
    expect(within(items[1] as HTMLElement).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(first).getByRole('button', { name: 'Delete checkout-error.png' })).toBeVisible();
  });

  it('[CORE-021] uploads files chosen, dropped or pasted, one request each', async () => {
    const user = userEvent.setup();
    let id = 100;
    const calls = openTicket({
      'POST /tickets/41/attachments': (body) => {
        const file = (body as FormData).get('file') as File;
        return jsonResponse(201, { attachment: uploaded(file.name, id++) });
      },
    });
    const input = await screen.findByLabelText('Attach files');
    await user.upload(input, [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ]);
    expect(await screen.findByText('a.txt attached. b.txt attached.')).toBeVisible();

    fireEvent.drop(panel(), {
      dataTransfer: { files: [new File(['c'], 'dropped.log', { type: 'text/plain' })] },
    });
    expect(await screen.findByText('dropped.log attached.')).toBeVisible();

    // A pasted screenshot gets a name of its own.
    fireEvent.paste(input, {
      clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })] },
    });
    expect(
      await screen.findByText(/^pasted-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.png attached\.$/),
    ).toBeVisible();

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => ((c.body as FormData).get('file') as File).name)).toEqual([
      'a.txt',
      'b.txt',
      'dropped.log',
      expect.stringMatching(/^pasted-.*\.png$/),
    ]);
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(10);
  });

  it('[CORE-021] refuses a file over the limit before sending it, and explains a refusal', async () => {
    const user = userEvent.setup();
    const calls = openTicket(
      {
        'POST /tickets/41/attachments': () =>
          jsonResponse(413, { error: 'file_too_large', maxFileSize: 10 }),
      },
      { maxFileSize: 10 },
    );
    const input = await screen.findByLabelText('Attach files');
    await user.upload(input, new File(['far more than ten bytes'], 'big.iso'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'big.iso is larger than the 10 B limit for one file.',
    );
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // The server has the last word (its limit may have changed since the page loaded).
    await user.upload(input, new File(['tiny'], 'tiny.bin'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'tiny.bin is larger than the 10 B limit for one file.',
    );
    expect(screen.getByText(/Up to 10 B each/)).toBeVisible();
  });

  it('[CORE-021] deletes after a confirmation', async () => {
    const user = userEvent.setup();
    const calls = openTicket({ 'DELETE /tickets/41/attachments/13': () => noContent() });
    await user.click(await screen.findByRole('button', { name: 'Delete server.log' }));
    expect(screen.getByText('Delete server.log for good?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete server.log' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('server.log deleted.')).toBeVisible();
    expect(within(panel()).queryByText('server.log')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/tickets/41/attachments/13',
    ]);
  });

  it('[CORE-021] previews text, ZIP contents and images in a dialog that Escape closes', async () => {
    const user = userEvent.setup();
    openTicket({
      'GET /tickets/41/attachments/13/text': () =>
        jsonResponse(200, { text: SERVER_LOG, truncated: true }),
      'GET /tickets/41/attachments/14/entries': () => jsonResponse(200, ZIP_LISTING),
    });
    const trigger = await screen.findByRole('button', { name: 'Preview server.log' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'server.log' });
    expect(await within(dialog).findByText(/payment declined: card expired/)).toBeVisible();
    expect(within(dialog).getByText(/Only the start of the file is shown/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close the preview' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Preview crash-dumps.zip' }));
    const zip = await screen.findByRole('dialog', { name: 'crash-dumps.zip' });
    expect(await within(zip).findByText('4 entries')).toBeVisible();
    expect(within(zip).getByRole('link', { name: 'Download dumps/README.txt' })).toHaveAttribute(
      'href',
      '/api/v1/tickets/41/attachments/14/entries/2/content',
    );
    expect(within(zip).getByText(/Unusual path/)).toBeVisible();
    await user.click(within(zip).getByRole('button', { name: 'Close the preview' }));

    await user.click(screen.getByRole('button', { name: 'Preview checkout-error.png' }));
    const image = await screen.findByRole('dialog', { name: 'checkout-error.png' });
    expect(within(image).getByRole('img', { name: 'checkout-error.png' })).toHaveAttribute(
      'src',
      '/api/v1/tickets/41/attachments/11/content?disposition=inline',
    );
  });

  it('[CORE-021] shows a viewer the files without the upload controls', async () => {
    openTicket(
      {},
      { canCreate: false, attachments: ATTACHMENTS.map((a) => ({ ...a, canDelete: false })) },
    );
    expect(await screen.findByText('You can view and download these files.')).toBeVisible();
    expect(screen.queryByLabelText('Attach files')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    // Dropping does nothing.
    fireEvent.drop(panel(), { dataTransfer: { files: [new File(['x'], 'x.txt')] } });
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(6);
  });

  it('[CORE-021] says when the ticket or its files cannot be read', async () => {
    stubBackend({ 'GET /tickets/NOPE-1': () => jsonResponse(404, { error: 'not_found' }) });
    window.location.hash = '#/tickets/NOPE-1';
    render(<App session={MEMBER} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no such ticket, or you cannot see it.',
    );
  });

  it('[CORE-021] works on a phone-sized screen', async () => {
    act(() => setViewportWidth(375));
    openTicket();
    expect(await screen.findByLabelText('Attach files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete checkout-error.png' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    stubBackend({
      'GET /tickets/SHOP-41': () => jsonResponse(200, { ticket: TICKET }),
      'GET /tickets/41/attachments': () =>
        jsonResponse(200, {
          attachments: ATTACHMENTS,
          maxFileSize: 1024 ** 3,
          canCreate: true,
          available: true,
        }),
    });
    window.location.hash = '#/tickets/SHOP-41';
    const errors: Error[] = [];
    render(<App session={MEMBER} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const texts = visibleTexts(main).filter(
      // File names are data, not interface text.
      (text) => !ATTACHMENTS.some((a) => a.name === text),
    );
    expect(texts.length).toBeGreaterThan(20);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

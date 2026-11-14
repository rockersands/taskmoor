import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { CloneDialog, type CloneSource } from './CloneDialog';
import type { CloneClient } from './client';
import { copied, fakeCloneClient, OUTCOME, SUBTICKET, TOO_MANY } from './fixtures';

function open(options: { ticket?: CloneSource; client?: CloneClient; locale?: Locale } = {}): {
  onCloned: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onCloned = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <CloneDialog
        ticket={options.ticket ?? OUTCOME}
        client={options.client ?? fakeCloneClient().client}
        onClose={onClose}
        onCloned={onCloned}
        pollMs={5}
      />
    </I18nProvider>,
  );
  return { onCloned, onClose };
}

const dialog = () => screen.findByRole('dialog', { name: 'Clone SHOP-7' });

describe('the clone dialog (M1-124)', () => {
  it('[CORE-023] clones a ticket with its subtickets, attachments and links, then opens the copy', async () => {
    const user = userEvent.setup();
    const fake = fakeCloneClient({ total: 4, step: 2 });
    const { onCloned } = open({ client: fake.client });
    const box = await dialog();
    expect(within(box).getByLabelText('Summary of the copy')).toHaveFocus();
    const track = within(box).getByRole('combobox', { name: 'Track' });
    await waitFor(() => expect(track).toBeEnabled());
    expect(track).toHaveTextContent('SHOP: Shop');
    for (const name of ['Subtickets', 'Attachments', 'Links and web links']) {
      expect(within(box).getByLabelText(name)).toBeChecked();
    }
    await user.click(within(box).getByRole('button', { name: 'Clone' }));
    expect(await within(box).findByText('Copied 4 of 4 tickets.')).toBeVisible();
    expect(fake.requests).toEqual([
      { subtickets: true, descendants: false, attachments: true, links: true },
    ]);
    expect(onCloned).toHaveBeenCalledWith('PAY-40');
  });

  it('[CORE-023] deep-clones into another track under a new summary', async () => {
    const user = userEvent.setup();
    const fake = fakeCloneClient();
    open({ client: fake.client });
    const box = await dialog();
    const summary = within(box).getByLabelText('Summary of the copy');
    await user.clear(summary);
    await user.type(summary, 'Checkout for the new store');
    const track = await within(box).findByRole('combobox', { name: 'Track' });
    await waitFor(() => expect(track).toBeEnabled());
    await user.click(track);
    await user.click(within(box).getByRole('option', { name: 'PAY: Payments' }));
    await user.click(
      within(box).getByLabelText('Everything below it, at every level (deep clone)'),
    );
    await user.click(within(box).getByLabelText('Attachments'));
    await user.click(within(box).getByRole('button', { name: 'Clone' }));
    await within(box).findByText('Copied 5 of 5 tickets.');
    expect(fake.requests).toEqual([
      {
        track: 'PAY',
        summary: 'Checkout for the new store',
        subtickets: true,
        descendants: true,
        attachments: false,
        links: true,
      },
    ]);
  });

  it('[CORE-023] says what was not copied instead of opening the copy', async () => {
    const user = userEvent.setup();
    const { onCloned } = open({
      client: fakeCloneClient({ total: 3, failed: 1, first: copied(['assigneeId', 'fields.12']) })
        .client,
    });
    const box = await dialog();
    await user.click(within(box).getByRole('button', { name: 'Clone' }));
    expect(await within(box).findByText('Copied 2 of 3 tickets.')).toBeVisible();
    expect(
      await within(box).findByText(
        'The copy is without what you may not set there or its track does not take: Assignee, a custom field.',
      ),
    ).toBeVisible();
    expect(within(box).getByRole('link', { name: 'Open PAY-40' })).toHaveAttribute(
      'href',
      '#/tickets/PAY-40',
    );
    expect(within(box).getByRole('link', { name: 'See each ticket’s result' })).toHaveAttribute(
      'href',
      '#/bulk/31',
    );
    expect(onCloned).not.toHaveBeenCalled();
  });

  it('[CORE-023] says why the ticket itself was not copied', async () => {
    const user = userEvent.setup();
    open({
      client: fakeCloneClient({
        total: 2,
        failed: 2,
        first: {
          position: 0,
          ref: 'SHOP-7',
          key: 'SHOP-7',
          outcome: 'failed',
          statusCode: 400,
          error: { error: 'invalid_fields' },
          result: null,
        },
      }).client,
    });
    const box = await dialog();
    await user.click(within(box).getByRole('button', { name: 'Clone' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent(
      'The ticket was not copied. Some of the values do not fit this ticket.',
    );
    expect(within(box).queryByRole('link', { name: /^Open / })).toBeNull();
  });

  it('[CORE-023] explains a clone the server refuses, and keeps the form', async () => {
    const user = userEvent.setup();
    open({ client: fakeCloneClient({ refuse: TOO_MANY }).client });
    const box = await dialog();
    await user.click(within(box).getByRole('button', { name: 'Clone' }));
    expect(await within(box).findByRole('alert')).toHaveTextContent(
      'That is more than 10,000 tickets, the most one clone may copy.',
    );
    expect(within(box).getByLabelText('Summary of the copy')).toBeVisible();
  });

  it('keeps a subticket in its track, and closes with Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = open({ ticket: SUBTICKET });
    const box = await screen.findByRole('dialog', { name: 'Clone SHOP-9' });
    expect(within(box).getByRole('combobox', { name: 'Track' })).toBeDisabled();
    expect(
      within(box).getByText('A subticket is copied into its own track, under its parent.'),
    ).toBeVisible();
    expect(within(box).queryByLabelText('Subtickets')).toBeNull();
    expect(within(box).queryByLabelText(/deep clone/)).toBeNull();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('fits a small phone', async () => {
    setViewportWidth(360);
    open();
    const box = await dialog();
    expect(within(box).getByRole('button', { name: 'Clone' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    open({ locale: 'en-XA' });
    const box = await screen.findByRole('dialog');
    // The Track picker is ready once the tracks are here.
    const track = await within(box).findByRole('combobox');
    await waitFor(() => expect(track).toBeEnabled());
    // The track's mark (its key's first letter) is data, as the key is.
    const data = new Set([
      'Checkout in one step',
      'SHOP-7',
      'Shop',
      'Payments',
      'SHOP',
      'PAY',
      'S',
    ]);
    const texts = visibleTexts(box).filter((t) => !data.has(t) && !/^\[?(SHOP|PAY):/.test(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

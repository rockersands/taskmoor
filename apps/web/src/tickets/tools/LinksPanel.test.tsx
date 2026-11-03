import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { linkCategories, pickerQuery } from './client';
import { fakeToolsClient, LINK_TYPES } from './fixtures';
import { LinksPanel } from './LinksPanel';

const TICKET = { id: 41, key: 'SHOP-41', track: { key: 'SHOP' } };

function renderPanel(
  client = fakeToolsClient(),
  locale: Locale = 'en',
  onChanged: () => void = () => {},
) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <LinksPanel ticket={TICKET} client={client} revision={0} onChanged={onChanged} />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

describe('the picker query (CORE-031)', () => {
  it('[CORE-031] looks only in the track and leaves the ticket itself out', () => {
    expect(pickerQuery('login', { trackKey: 'SHOP', exclude: 'SHOP-41' })).toBe(
      'track = "SHOP" AND key != "SHOP-41" AND (summary ~ "login*") ORDER BY updated DESC',
    );
  });

  it('[CORE-031] reads a number as a ticket of the track, and a key as that key', () => {
    expect(pickerQuery('42', { trackKey: 'SHOP' })).toBe(
      'track = "SHOP" AND (key = "SHOP-42" OR summary ~ "42*") ORDER BY updated DESC',
    );
    expect(pickerQuery('shop-42', { trackKey: 'SHOP' })).toBe(
      'track = "SHOP" AND (key = "SHOP-42" OR summary ~ "shop 42*") ORDER BY updated DESC',
    );
  });

  it('[CORE-031] lets no typed character change the query', () => {
    const query = pickerQuery('a" OR track != "X\\', { trackKey: 'SHOP' });
    expect(query).toBe('track = "SHOP" AND (summary ~ "a OR track X*") ORDER BY updated DESC');
    expect(pickerQuery('  "*~  ', { trackKey: 'SHOP' })).toBeNull();
    expect(pickerQuery('   ')).toBeNull();
  });
});

describe('link categories (CORE-031)', () => {
  it('[CORE-031] offers each side of a link type, and one choice where both read the same', () => {
    expect(linkCategories(LINK_TYPES).map((c) => c.phrase)).toEqual([
      'blocks',
      'is blocked by',
      'copies',
      'is copied by',
      'duplicates',
      'is duplicated by',
      'relates to',
    ]);
  });
});

describe('LinksPanel', () => {
  it('[CORE-031] groups links under what they read from this side, whichever side made them', async () => {
    renderPanel();
    const panel = await screen.findByRole('region', { name: 'Links' });
    expect(within(panel).getByRole('heading', { name: 'blocks' })).toBeVisible();
    expect(within(panel).getByRole('heading', { name: 'is blocked by' })).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'SHOP-39' })).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'Pull request 7' })).toBeVisible();
  });

  it('[CORE-031] shows a link to another track, and removes it', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Remove the link: is blocked by OPS-88' }),
    );
    await waitFor(() => expect(screen.queryByRole('link', { name: 'OPS-88' })).toBeNull());
    expect(client.calls).toContainEqual({ action: 'removeLink', args: [41, 2] });
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
      'Removed: is blocked by OPS-88.',
    );
  });

  it('[CORE-031] keeps the focus in the panel when a link goes while the form is open', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a link' }));
    const picker = await screen.findByRole('combobox', { name: 'Ticket number or name' });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Remove the link: is blocked by OPS-88' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'OPS-88' })).toBeNull());
    await waitFor(() => expect(picker).toHaveFocus());
  });

  it('[CORE-031] keeps the focus in the panel when a link goes and the form offers no category', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    client.linkTypes = async () => ({ enabled: true, linkTypes: [] });
    renderPanel(client);
    await user.click(await screen.findByRole('button', { name: 'Add a link' }));
    const done = await screen.findByRole('button', { name: 'Done' });
    await user.click(screen.getByRole('button', { name: 'Remove the link: blocks SHOP-39' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'SHOP-39' })).toBeNull());
    await waitFor(() => expect(done).toHaveFocus());
  });

  it('[CORE-031] adds several links in a row, by keyboard, from what is typed', async () => {
    const user = userEvent.setup();
    const changed: number[] = [];
    const { client } = renderPanel(undefined, 'en', () => changed.push(1));
    await user.click(await screen.findByRole('button', { name: 'Add a link' }));
    const category = await screen.findByRole('combobox', { name: 'How it relates' });
    await waitFor(() =>
      expect(within(category).getByRole('option', { name: 'relates to' })).toBeInTheDocument(),
    );
    const picker = screen.getByRole('combobox', { name: 'Ticket number or name' });
    await waitFor(() => expect(picker).toHaveFocus());
    await user.selectOptions(category, 'relates to');
    await user.type(picker, 'retry');
    const list = await screen.findByRole('listbox', { name: 'Ticket number or name' });
    expect(await within(list).findByRole('option', { selected: true })).toHaveTextContent(
      'SHOP-40',
    );
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('link', { name: 'SHOP-40' })).toBeVisible();
    expect(client.calls).toContainEqual({
      action: 'addLink',
      args: [41, { linkTypeId: 4, direction: 'outward', ticket: 40 }],
    });
    expect(changed).toEqual([1]);

    // Focus stays in the field for the next one.
    await waitFor(() => expect(picker).toHaveFocus());
    await user.keyboard('42');
    await within(await screen.findByRole('listbox', { name: 'Ticket number or name' })).findByRole(
      'option',
      { name: /SHOP-42/ },
    );
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('link', { name: 'SHOP-42' })).toBeVisible();
    const queries = client.calls.filter((c) => c.action === 'pick').map((c) => String(c.args[0]));
    for (const query of queries) {
      expect(query).toContain('track = "SHOP"');
      expect(query).toContain('key != "SHOP-41"');
    }
  });

  it('[CORE-031] walks the list with the arrow keys and closes it with Escape', async () => {
    const user = userEvent.setup();
    renderPanel(fakeToolsClient({ links: [] }));
    await user.click(await screen.findByRole('button', { name: 'Add a link' }));
    const picker = await screen.findByRole('combobox', { name: 'Ticket number or name' });
    await user.type(picker, 'e');
    const list = await screen.findByRole('listbox', { name: 'Ticket number or name' });
    const options = await within(list).findAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(picker.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(picker).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Ticket number or name' })).toBeNull(),
    );
  });

  it('[CORE-031] does not offer a ticket already linked', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Add a link' }));
    await user.type(
      await screen.findByRole('combobox', { name: 'Ticket number or name' }),
      'payment',
    );
    const list = await screen.findByRole('listbox', { name: 'Ticket number or name' });
    await within(list).findByRole('option', { name: /SHOP-40/ });
    expect(within(list).queryByRole('option', { name: /SHOP-39/ })).toBeNull();
  });

  it('[CORE-031] offers no changes to someone who may not link', async () => {
    renderPanel(fakeToolsClient({ mayLink: false }));
    await screen.findByRole('link', { name: 'SHOP-39' });
    expect(screen.queryByRole('button', { name: 'Add a link' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove the link/ })).toBeNull();
  });

  it('[CORE-031] says so when the server refuses', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    const { ApiError } = await import('../../api/client');
    client.removeLink = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    renderPanel(client);
    await user.click(
      await screen.findByRole('button', { name: 'Remove the link: blocks SHOP-39' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You may not make this change to this ticket.',
    );
    expect(screen.getByRole('link', { name: 'SHOP-39' })).toBeVisible();
  });

  it('[CORE-031] works on a phone', async () => {
    setViewportWidth(360);
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Add a link' })).toBeVisible();
  });

  it('[NFR-006] comes from the catalogue, in the pseudo-locale too', async () => {
    const user = userEvent.setup();
    const { errors, container } = renderPanel(undefined, 'en-XA');
    const add = (await screen.findAllByRole('button'))[0] as HTMLElement;
    await user.click(add);
    await screen.findAllByRole('combobox');
    expect(errors).toEqual([]);
    const texts = visibleTexts(container).filter(
      (text) =>
        !/SHOP|OPS|Pull request|blocks|blocked|Payment|Database|relates|cop|dup/i.test(text),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

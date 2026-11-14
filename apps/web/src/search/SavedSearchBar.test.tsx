import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { applyStylesheet } from '../test/stylesheets';
import { fakeSavedSearchClient } from './fixtures';
import { SavedSearchBar } from './SavedSearchBar';
import type { SavedSearch } from './savedClient';

function renderBar(opened: SavedSearch | null, client = fakeSavedSearchClient()) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={MEMBER}>
        <SavedSearchBar
          client={client}
          query="track = SHOP"
          columns={['summary']}
          opened={opened}
          onOpen={vi.fn()}
          onSaved={vi.fn()}
        />
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe('the saved searches bar (M1-063)', () => {
  it('[QRY-011] shows the open saved search in the picker, not "Choose" (PL-12)', async () => {
    const client = fakeSavedSearchClient();
    const opened = client.saved[0] as SavedSearch;
    renderBar(opened, client);
    const picker = screen.getByRole('combobox', { name: 'Saved searches you can see' });
    await within(picker).findByRole('option', { name: 'My open work' });
    expect(picker).toHaveValue('1');
    expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(
      'My open work',
    );
  });

  it('[QRY-011] lets a long name end in an ellipsis before the arrow (PL-12)', () => {
    const gone = applyStylesheet('search.css');
    try {
      renderBar(null);
      const picker = screen.getByRole('combobox', { name: 'Saved searches you can see' });
      expect(getComputedStyle(picker).textOverflow).toBe('ellipsis');
      expect(getComputedStyle(picker).whiteSpace).toBe('nowrap');
    } finally {
      gone();
    }
  });

  it('[QRY-011] [QRY-012] shows whether the search is starred and subscribed (PL-32)', async () => {
    const user = userEvent.setup();
    const client = fakeSavedSearchClient();
    const opened = client.saved[0] as SavedSearch;
    renderBar(opened, client);
    const star = screen.getByRole('button', { name: 'Star' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    expect(star).toHaveTextContent('★');
    const subscribe = screen.getByRole('button', { name: 'Subscribe' });
    expect(subscribe).not.toHaveAttribute('data-on');
    // Like Star, Subscribe carries a mark and a pressed state either way (PL-32).
    expect(subscribe).toHaveAttribute('aria-pressed', 'false');
    expect(subscribe).toHaveTextContent('✉');
    await user.click(subscribe);
    await user.click(screen.getByRole('button', { name: 'Subscribe by email' }));
    const subscribed = await screen.findByRole('button', { name: 'Subscribed' });
    expect(subscribed).toHaveAttribute('data-on');
    expect(subscribed).toHaveAttribute('aria-pressed', 'true');
    expect(subscribed).toHaveTextContent('✓');
  });

  it('[QRY-012] reads that the person already gets it by email', async () => {
    const client = fakeSavedSearchClient();
    const asked = vi.fn(async () => true);
    client.subscribedTo = asked;
    renderBar({ ...(client.saved[1] as SavedSearch) }, client);
    expect(await screen.findByRole('button', { name: 'Subscribed' })).toBeVisible();
    await waitFor(() => expect(asked).toHaveBeenCalledWith(2, 2));
    expect(screen.getByRole('button', { name: 'Star' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Star' })).toHaveTextContent('☆');
  });
});

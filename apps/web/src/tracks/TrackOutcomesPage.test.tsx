import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { TrackOutcome } from './client';
import { fakeTrackClient, outcomePages, SHOP_OUTCOMES } from './fixtures';
import { TrackLayout } from './TrackLayout';
import { TrackOutcomesPage } from './TrackOutcomesPage';

const show = (node: React.ReactNode, locale: 'en' | 'es' = 'en') =>
  render(<I18nProvider locale={locale}>{node}</I18nProvider>);

/** `count` open outcomes, ranked in key order, each with as many tickets as its number. */
const many = (count: number): TrackOutcome[] =>
  Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    key: `BIG-${i + 1}`,
    summary: `Goal ${i + 1}`,
    type: 'Outcome',
    status: { name: 'New', stage: 'new' },
    startDate: null,
    dueDate: null,
    progress: { total: i + 1, closed: 0 },
  }));

describe("a track's outcomes (AGL-024)", () => {
  it('[AGL-024] has an Outcomes tab among the sections, current on its page', async () => {
    show(
      <TrackLayout trackKey="SHOP" section="outcomes" client={fakeTrackClient()}>
        <p>page</p>
      </TrackLayout>,
    );
    const bar = screen.getByRole('navigation', { name: 'Sections of SHOP' });
    const tab = await within(bar).findByRole('link', { name: 'Outcomes' });
    expect(tab).toHaveAttribute('href', '#/tracks/SHOP/outcomes');
    expect(tab).toHaveAttribute('aria-current', 'page');
  });

  it('[AGL-024] lists each outcome with its key, summary, status, progress and dates', async () => {
    show(<TrackOutcomesPage trackKey="SHOP" client={fakeTrackClient()} />);
    const list = await screen.findByRole('list', { name: 'Outcomes' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      'SHOP-50 Card payments in every market',
      'SHOP-51 A faster checkout',
      'SHOP-52 Gift cards',
      'SHOP-47 Saved addresses',
    ]);
    const [first, second, empty, closed] = rows as HTMLElement[];
    // The link is the ticket's own address, which opens the ticket over the page.
    expect(within(first as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '#/tickets/SHOP-50',
    );
    expect(within(first as HTMLElement).getByRole('img', { name: 'Outcome' })).toBeVisible();
    expect(within(first as HTMLElement).getByText('Active')).toBeVisible();
    const bar = within(first as HTMLElement).getByRole('progressbar', {
      name: '5 of 8 closed (63%)',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '63');
    expect(within(first as HTMLElement).getByText('5 of 8')).toBeVisible();
    expect(
      within(first as HTMLElement).getByText('Starts Oct 5, 2026 · Due Dec 18, 2026'),
    ).toBeVisible();
    expect(within(second as HTMLElement).getByText('Due Jan 29, 2027')).toBeVisible();
    // Nothing under it yet: no bar, and it says so; no dates, no line for them.
    expect(within(empty as HTMLElement).queryByRole('progressbar')).toBeNull();
    expect(within(empty as HTMLElement).getByText('No tickets under it yet')).toBeVisible();
    expect(within(empty as HTMLElement).queryByText(/Due|Starts/)).toBeNull();
    expect(within(closed as HTMLElement).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });

  it('[AGL-024] shows 100 at a time and the next page on asking', async () => {
    const client = fakeTrackClient();
    const pages = vi.fn(outcomePages(many(130), 100));
    client.outcomes = pages;
    show(<TrackOutcomesPage trackKey="BIG" client={client} />);
    const list = await screen.findByRole('list', { name: 'Outcomes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: 'Show more outcomes' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(130));
    expect(pages).toHaveBeenLastCalledWith('BIG', '100');
    expect(within(list).getAllByRole('link').at(-1)).toHaveTextContent('BIG-130 Goal 130');
    expect(screen.queryByRole('button', { name: 'Show more outcomes' })).toBeNull();
  });

  it('[AGL-024] keeps what it shows when the next page fails, and says so', async () => {
    const client = fakeTrackClient();
    const first = outcomePages(many(101), 100);
    client.outcomes = async (key, cursor) => {
      if (cursor) throw new Error('offline');
      return first(key);
    };
    show(<TrackOutcomesPage trackKey="BIG" client={client} />);
    const list = await screen.findByRole('list', { name: 'Outcomes' });
    fireEvent.click(screen.getByRole('button', { name: 'Show more outcomes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'More outcomes could not be loaded. Try again.',
    );
    expect(within(list).getAllByRole('listitem')).toHaveLength(100);
    expect(screen.getByRole('button', { name: 'Show more outcomes' })).toBeVisible();
  });

  it('[AGL-024] explains what an outcome is and which type makes one when there are none', async () => {
    const client = fakeTrackClient();
    client.outcomes = outcomePages([], 100, ['Outcome', 'Initiative']);
    show(<TrackOutcomesPage trackKey="SHOP" client={client} />);
    expect(await screen.findByText('No outcomes yet')).toBeVisible();
    expect(
      screen.getByText(/An outcome is a larger goal, such as a launch or a theme/),
    ).toHaveTextContent(
      'To add one, create a ticket of the type Outcome or Initiative, then add the tickets that work towards it from its page.',
    );
    expect(screen.getByRole('link', { name: 'Create a ticket' })).toHaveAttribute(
      'href',
      '#/create',
    );
  });

  it('[AGL-024] says who can add an outcome type when the track has none', async () => {
    const client = fakeTrackClient();
    client.outcomes = outcomePages([], 100, []);
    show(<TrackOutcomesPage trackKey="SHOP" client={client} />);
    expect(
      await screen.findByText(/None of this track's ticket types is at the outcome level/),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Create a ticket' })).toBeNull();
  });

  it('[AGL-024] says plainly when the outcomes cannot be read', async () => {
    const client = fakeTrackClient();
    client.outcomes = async () => {
      throw new Error('offline');
    };
    show(<TrackOutcomesPage trackKey="SHOP" client={client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The outcomes could not be loaded.');
  });

  it('[AGL-024] reads as Objetivos in Spanish, the seeded type in Spanish too', async () => {
    show(
      <TrackLayout trackKey="SHOP" section="outcomes" client={fakeTrackClient()}>
        <TrackOutcomesPage trackKey="SHOP" client={fakeTrackClient()} />
      </TrackLayout>,
      'es',
    );
    const bar = screen.getByRole('navigation', { name: 'Secciones de SHOP' });
    expect(await within(bar).findByRole('link', { name: 'Objetivos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Objetivos' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '5 de 8 cerrados (63 %)' })).toBeVisible();
    expect(screen.getAllByRole('img', { name: 'Objetivo' })).toHaveLength(SHOP_OUTCOMES.length);
  });
});

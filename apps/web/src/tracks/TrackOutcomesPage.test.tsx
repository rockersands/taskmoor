import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { OutcomeRights, TrackOutcome } from './client';
import {
  fakeTrackClient,
  managedOutcomes,
  NO_RIGHTS,
  OUTCOME_WAYS,
  outcomePages,
  SHOP_OUTCOMES,
} from './fixtures';
import { TrackLayout } from './TrackLayout';
import { TrackOutcomesPage } from './TrackOutcomesPage';

const show = (node: React.ReactNode, locale: Locale = 'en') =>
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
      await screen.findByText(/None of this track’s ticket types is at the outcome level/),
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

describe("managing a track's outcomes from the Outcomes tab (AGL-024; T-082)", () => {
  afterEach(() => {
    setViewportWidth(1280);
  });

  /** The page over outcomes the panel changes, with the person's rights; the panel opened. */
  async function managing(
    options: Parameters<typeof managedOutcomes>[1] = {},
    locale: Locale = 'en',
  ) {
    const user = userEvent.setup();
    const made = managedOutcomes(SHOP_OUTCOMES, options);
    const client = fakeTrackClient();
    client.outcomes = made.outcomes;
    const view = show(
      <TrackOutcomesPage trackKey="SHOP" client={client} manager={made.manager} />,
      locale,
    );
    await screen.findByRole('list', { name: /.+/ });
    const toggle = view.container.querySelector('button[aria-controls$="-manage"]') as HTMLElement;
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    return { ...made, user, container: view.container };
  }
  const keys = () =>
    within(screen.getByRole('list', { name: 'Outcomes' }))
      .getAllByRole('link')
      .map((a) => a.textContent?.split(' ')[0]);
  const tools = (key: string) => screen.getByRole('group', { name: `Manage ${key}` });

  it('[AGL-024] offers no manage panel to someone who may manage nothing', async () => {
    const client = fakeTrackClient();
    client.outcomes = outcomePages(SHOP_OUTCOMES, 100, ['Outcome'], NO_RIGHTS);
    show(<TrackOutcomesPage trackKey="SHOP" client={client} />);
    await screen.findByRole('list', { name: 'Outcomes' });
    expect(screen.queryByRole('button', { name: 'Manage outcomes' })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Manage / })).toBeNull();
  });

  it('[AGL-024] creates an outcome of the outcome-level type, and asks for a summary first', async () => {
    const { user, calls } = await managing();
    const panel = screen.getByRole('region', { name: 'Manage outcomes' });
    const create = within(panel).getByRole('button', { name: 'Create outcome' });
    await user.click(create);
    expect(within(panel).getByText('Give the outcome a summary.')).toBeVisible();
    expect(within(panel).getByLabelText('Summary')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toEqual([]);

    await user.type(within(panel).getByLabelText('Summary'), '  Loyalty points ');
    await user.click(create);
    expect(await screen.findByText('Created SHOP-60.')).toBeVisible();
    expect(calls).toEqual([['create', 'SHOP', 9, 'Loyalty points']]);
    // Listed with the open ones, before the closed one, and the field is ready for the next.
    expect(keys()).toEqual(['SHOP-50', 'SHOP-51', 'SHOP-52', 'SHOP-60', 'SHOP-47']);
    expect(within(panel).getByLabelText('Summary')).toHaveValue('');
    // One outcome-level type: no choice to make.
    expect(within(panel).queryByLabelText('Type')).toBeNull();
  });

  it('[AGL-024] lets the person choose the type when the track has several at the outcome level', async () => {
    const rights: OutcomeRights = {
      create: true,
      edit: true,
      schedule: true,
      close: true,
      types: [
        { id: 9, name: 'Outcome' },
        { id: 12, name: 'Initiative' },
      ],
    };
    const { user, calls } = await managing({ rights });
    const panel = screen.getByRole('region', { name: 'Manage outcomes' });
    await user.selectOptions(within(panel).getByLabelText('Type'), 'Initiative');
    await user.type(within(panel).getByLabelText('Summary'), 'New market{Enter}');
    await screen.findByText('Created SHOP-60.');
    expect(calls).toEqual([['create', 'SHOP', 12, 'New market']]);
  });

  it('[AGL-024] edits an outcome’s summary and dates, sending only what changed', async () => {
    const { user, calls } = await managing();
    await user.click(within(tools('SHOP-51')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit SHOP-51' });
    expect(within(form).getByLabelText('Due date')).toHaveValue('2027-01-29');
    await user.clear(within(form).getByLabelText('Summary'));
    await user.type(within(form).getByLabelText('Summary'), 'A quicker checkout');
    fireEvent.change(within(form).getByLabelText('Due date'), {
      target: { value: '2027-02-26' },
    });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved SHOP-51.')).toBeVisible();
    expect(calls).toEqual([['edit', 51, { summary: 'A quicker checkout', dueDate: '2027-02-26' }]]);
    expect(screen.getByRole('link', { name: 'SHOP-51 A quicker checkout' })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Edit SHOP-51' })).toBeNull();
  });

  it('[AGL-024] moves an open outcome up or down among the open ones, never a closed one', async () => {
    const { user, calls } = await managing();
    expect(within(tools('SHOP-50')).queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(within(tools('SHOP-52')).queryByRole('button', { name: 'Move down' })).toBeNull();
    expect(within(tools('SHOP-47')).queryByRole('button', { name: /Move|Close/ })).toBeNull();

    await user.click(within(tools('SHOP-52')).getByRole('button', { name: 'Move up' }));
    expect(await screen.findByText('Moved SHOP-52 up.')).toBeVisible();
    expect(calls).toEqual([['rank', 52, { before: 51 }]]);
    expect(keys()).toEqual(['SHOP-50', 'SHOP-52', 'SHOP-51', 'SHOP-47']);

    await user.click(within(tools('SHOP-50')).getByRole('button', { name: 'Move down' }));
    expect(await screen.findByText('Moved SHOP-50 down.')).toBeVisible();
    expect(calls.at(-1)).toEqual(['rank', 50, { after: 52 }]);
    expect(keys()).toEqual(['SHOP-52', 'SHOP-50', 'SHOP-51', 'SHOP-47']);
  });

  it('[AGL-024] closes an outcome by its workflow’s one way into the closed stage', async () => {
    const { user, calls } = await managing();
    await user.click(within(tools('SHOP-50')).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Closed SHOP-50.')).toBeVisible();
    expect(calls).toEqual([
      ['transitions', 50],
      ['transition', 50, 2],
    ]);
    // Now with the closed ones, after the open.
    expect(keys()).toEqual(['SHOP-51', 'SHOP-52', 'SHOP-50', 'SHOP-47']);
  });

  it('[AGL-024] asks which way to close when the workflow offers several, and for a close reason when one asks', async () => {
    const ways = [
      ...OUTCOME_WAYS,
      {
        id: 3,
        name: 'Drop',
        to: { id: 4, name: 'Dropped', stage: 'closed' },
        layout: ['close-reason'],
      },
    ];
    const { user, calls } = await managing({ ways });
    await user.click(within(tools('SHOP-51')).getByRole('button', { name: 'Close' }));
    const how = await screen.findByRole('group', { name: 'How to close SHOP-51' });
    expect(
      within(how)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Done', 'Drop', 'Cancel']);
    await user.click(within(how).getByRole('button', { name: 'Drop' }));
    const form = await screen.findByRole('form', { name: /Drop/ });
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Drop' })).toBeEnabled());
    await user.click(within(form).getByRole('button', { name: 'Drop' }));
    expect(await screen.findByText('Closed SHOP-51.')).toBeVisible();
    expect(calls.at(-1)).toEqual(['transition', 51, 3, { 'close-reason': 1 }]);
  });

  it('[AGL-024] says so when the workflow offers no way to close it from where it is', async () => {
    const start = OUTCOME_WAYS.filter((w) => w.to.stage !== 'closed');
    const { user, calls } = await managing({ ways: start });
    await user.click(within(tools('SHOP-52')).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'SHOP-52’s workflow offers no way to a closed status from where it is now.',
    );
    expect(calls).toEqual([['transitions', 52]]);
  });

  it('[AGL-024] offers only what the person’s roles allow', async () => {
    const { user } = await managing({
      rights: { create: false, edit: false, schedule: true, close: false, types: [] },
    });
    const panel = screen.getByRole('region', { name: 'Manage outcomes' });
    expect(within(panel).queryByRole('form', { name: 'New outcome' })).toBeNull();
    expect(within(tools('SHOP-51')).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(tools('SHOP-51')).getByRole('button', { name: 'Move up' })).toBeVisible();
    await user.click(within(tools('SHOP-51')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit SHOP-51' });
    expect(within(form).queryByLabelText('Summary')).toBeNull();
    expect(within(form).getByLabelText('Start date')).toBeVisible();
  });

  it('[AGL-024] says why when the server refuses a change, and keeps the list as it was', async () => {
    const { user } = await managing({
      refuse: new ApiError(403, { error: 'forbidden', permission: 'schedule_tickets' }),
    });
    await user.click(within(tools('SHOP-51')).getByRole('button', { name: 'Move up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You may not make this change to this outcome.',
    );
    expect(keys()).toEqual(['SHOP-50', 'SHOP-51', 'SHOP-52', 'SHOP-47']);
  });

  it('[AGL-024] opens the panel from an empty list, ready for a summary', async () => {
    const user = userEvent.setup();
    const made = managedOutcomes([]);
    const client = fakeTrackClient();
    client.outcomes = made.outcomes;
    show(<TrackOutcomesPage trackKey="SHOP" client={client} manager={made.manager} />);
    expect(
      await screen.findByText(/Choose New outcome to create one of the type Outcome/),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Create a ticket' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New outcome' }));
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveFocus();
  });

  it('[AGL-024] keeps the focus in the row as editing opens, saves and is cancelled', async () => {
    const { user } = await managing();
    const edit = () => within(tools('SHOP-51')).getByRole('button', { name: 'Edit' });
    await user.click(edit());
    const form = screen.getByRole('form', { name: 'Edit SHOP-51' });
    expect(within(form).getByLabelText('Summary')).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(edit()).toHaveFocus();

    await user.keyboard('{Enter}');
    const again = screen.getByRole('form', { name: 'Edit SHOP-51' });
    await user.type(within(again).getByLabelText('Summary'), '!{Enter}');
    expect(await screen.findByText('Saved SHOP-51.')).toBeVisible();
    expect(edit()).toHaveFocus();
  });

  it('[AGL-024] keeps the focus in the row as it closes, by one way or by choosing', async () => {
    const ways = [
      ...OUTCOME_WAYS,
      {
        id: 3,
        name: 'Drop',
        to: { id: 4, name: 'Dropped', stage: 'closed' },
        layout: ['close-reason'],
      },
    ];
    const { user } = await managing({ ways });
    const close = () => within(tools('SHOP-51')).getByRole('button', { name: 'Close' });
    await user.click(close());
    const how = await screen.findByRole('group', { name: 'How to close SHOP-51' });
    expect(within(how).getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.click(within(how).getByRole('button', { name: 'Cancel' }));
    expect(close()).toHaveFocus();

    await user.keyboard('{Enter}');
    const again = await screen.findByRole('group', { name: 'How to close SHOP-51' });
    await user.click(within(again).getByRole('button', { name: 'Drop' }));
    const form = await screen.findByRole('form', { name: /Drop/ });
    expect(within(form).getByLabelText('Close reason')).toHaveFocus();
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Drop' })).toBeEnabled());
    await user.click(within(form).getByRole('button', { name: 'Drop' }));
    expect(await screen.findByText('Closed SHOP-51.')).toBeVisible();
    // Closed, it has no Close; its Edit takes the focus.
    expect(within(tools('SHOP-51')).getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('[AGL-024] keeps the focus on a closed outcome when its one way closes it at once', async () => {
    const { user } = await managing({
      rights: { create: false, edit: false, schedule: false, close: true, types: [] },
    });
    await user.click(within(tools('SHOP-50')).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Closed SHOP-50.')).toBeVisible();
    // No tool left to it: its link takes the focus.
    expect(
      screen.getByRole('link', { name: 'SHOP-50 Card payments in every market' }),
    ).toHaveFocus();
  });

  it('[AGL-024] keeps the focus on the moved outcome, at the top or the bottom too', async () => {
    const { user } = await managing();
    await user.click(within(tools('SHOP-51')).getByRole('button', { name: 'Move up' }));
    expect(await screen.findByText('Moved SHOP-51 up.')).toBeVisible();
    // At the top it has no Move up: Move down takes the focus.
    expect(within(tools('SHOP-51')).getByRole('button', { name: 'Move down' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByText('Moved SHOP-51 down.')).toBeVisible();
    expect(keys()).toEqual(['SHOP-50', 'SHOP-51', 'SHOP-52', 'SHOP-47']);
    expect(within(tools('SHOP-51')).getByRole('button', { name: 'Move down' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByText('Moved SHOP-51 down.')).toBeVisible();
    expect(keys()).toEqual(['SHOP-50', 'SHOP-52', 'SHOP-51', 'SHOP-47']);
    expect(within(tools('SHOP-51')).getByRole('button', { name: 'Move up' })).toHaveFocus();
  });

  it('[AGL-024] reports a change as made when only reading the list again fails', async () => {
    const user = userEvent.setup();
    const made = managedOutcomes(SHOP_OUTCOMES);
    const client = fakeTrackClient();
    let reads = 0;
    client.outcomes = async (key, cursor) => {
      reads += 1;
      if (reads > 1) throw new Error('offline');
      return made.outcomes(key, cursor);
    };
    show(<TrackOutcomesPage trackKey="SHOP" client={client} manager={made.manager} />);
    await user.click(await screen.findByRole('button', { name: 'Manage outcomes' }));
    const panel = screen.getByRole('region', { name: 'Manage outcomes' });
    await user.type(within(panel).getByLabelText('Summary'), 'Loyalty points{Enter}');
    expect(await screen.findByText('Created SHOP-60.')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The change was made, but the list could not be read again.',
    );
    // Not offered again as if it had failed: the field is cleared, and one outcome was made.
    expect(within(panel).getByLabelText('Summary')).toHaveValue('');
    expect(made.calls).toEqual([['create', 'SHOP', 9, 'Loyalty points']]);
  });

  it('[AGL-024] fits a phone with the panel open, without sideways scrolling', async () => {
    setViewportWidth(375);
    const { user } = await managing();
    await user.click(within(tools('SHOP-50')).getByRole('button', { name: 'Edit' }));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[AGL-024] every text of the panel goes through the catalogue (en-XA)', async () => {
    const { container, user } = await managing({}, 'en-XA');
    const row = container.querySelector('.track-outcome-tools button') as HTMLElement;
    await user.click(row);
    // Keys, summaries, statuses and dates are data.
    const data = new Set([
      'Shop',
      '·',
      ...SHOP_OUTCOMES.flatMap((o) => [o.key, o.summary, o.status.name]),
    ]);
    const texts = visibleTexts(container).filter((t) => !/\d/.test(t) && !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

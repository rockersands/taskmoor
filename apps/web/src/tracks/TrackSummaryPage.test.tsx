import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { FakeTrackClient } from './fixtures';
import { CUSTOM_WIDGETS, fakeTrackClient, SHOP_SUMMARY } from './fixtures';
import { filterOfRoute, routeWithFilter, TrackSummaryPage } from './TrackSummaryPage';
import { TrackSectionsContext } from './trackSections';

function open(locale: Locale = 'en', client: FakeTrackClient = fakeTrackClient()) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <TrackSummaryPage trackKey="SHOP" client={client} checkQuery={async () => true} />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}
const CUSTOM = { layout: 'two' as const, version: 3, widgets: CUSTOM_WIDGETS };

describe('a Summary on a Kanban track (ADR-116)', () => {
  const sprintWidget = {
    id: 'sb',
    kind: 'sprint-burndown' as const,
    column: 0,
    title: 'Our burndown',
    config: {},
  };
  const KANBAN = { backlog: false, sprints: false };

  it('[CORE-002] leaves out sprint widgets, and keeps them in the editor to take away', async () => {
    const user = userEvent.setup();
    const client = fakeTrackClient(SHOP_SUMMARY, {
      mayCustomize: true,
      custom: { layout: 'two', version: 1, widgets: [...CUSTOM_WIDGETS, sprintWidget] },
    });
    render(
      <I18nProvider locale="en">
        <TrackSectionsContext.Provider value={KANBAN}>
          <TrackSummaryPage trackKey="SHOP" client={client} checkQuery={async () => true} />
        </TrackSectionsContext.Provider>
      </I18nProvider>,
    );
    expect(await screen.findByText('Open bugs')).toBeVisible();
    expect(screen.queryByText('Our burndown')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Customise' }));
    expect(await screen.findByText('Our burndown')).toBeVisible();
    const offered = within(screen.getByRole('combobox', { name: 'Widget to add' }))
      .getAllByRole('option')
      .map((o) => o.textContent)
      .join();
    expect(offered).toContain('Created vs closed');
    // The reports of tickets and time need no sprint, so a Kanban track offers them too.
    for (const kind of ['Tickets by date', 'Grouped tickets', 'Workload', 'Time tracking']) {
      expect(offered).toContain(kind);
    }
    expect(offered).not.toMatch(/Scrum|Sprint/);
  });
});

describe('track summary page (M1-064)', () => {
  it('[RPT-006] every number opens the search that counts it', async () => {
    open();
    // Titled by its section, the track named above it (D26).
    const heading = await screen.findByRole('heading', { level: 1, name: 'Summary' });
    expect(within(heading.closest('header') as HTMLElement).getByText('Shop')).toBeVisible();
    const open26 = await screen.findByRole('link', { name: '26' });
    expect(open26).toHaveAttribute(
      'href',
      `#/search?q=${encodeURIComponent('track = SHOP AND closeReason IS EMPTY').replace(/%20/g, '+')}`,
    );
    const priorities = screen.getByRole('region', { name: 'Open by priority' });
    expect(
      within(priorities)
        .getAllByRole('link')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual([
      'High 8, open the search',
      'Medium 12, open the search',
      'No priority 6, open the search',
    ]);
    const assignees = screen.getByRole('region', { name: 'Open by assignee' });
    expect(
      within(assignees).getByRole('link', { name: 'Unassigned 7, open the search' }),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'By stage' })).toHaveTextContent(
      'New 14Active 12Closed 120',
    );
  });

  it('[RPT-006] says a count past the search cap is at least that', async () => {
    const capped = {
      ...SHOP_SUMMARY,
      overview: SHOP_SUMMARY.overview.map((i) =>
        i.id === 'open' ? { ...i, count: 10_000, exact: false } : i,
      ),
    };
    open('en', fakeTrackClient(capped));
    expect(await screen.findByRole('link', { name: '10,000+' })).toBeVisible();
  });

  it('[CORE-015] [CORE-029] leads to the track’s ticket templates and areas, for anyone who reads it', async () => {
    open();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Summary' });
    const header = heading.closest('header') as HTMLElement;
    expect(within(header).getByRole('link', { name: 'Ticket templates' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/templates',
    );
    expect(within(header).getByRole('link', { name: 'Areas' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/areas',
    );
  });

  it('[RPT-006] says when the track cannot be read', async () => {
    open('en', fakeTrackClient(null));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This track does not exist, or you cannot see it.',
    );
  });

  it('[RPT-006] fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open();
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-006] every text goes through the catalogue (en-XA)', async () => {
    const { container, errors } = open('en-XA');
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(container.querySelector('.summary-sections')).not.toBeNull());
    // The track's name above the title is data too.
    const data = new Set([
      'Shop',
      'High',
      'Medium',
      'Bug',
      'Feature',
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    const texts = visibleTexts(container).filter((t) => !/\d/.test(t) && !data.has(t));
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('a customized track summary (ADR-116)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const customizable = (custom: Parameters<typeof fakeTrackClient>[1] = {}) =>
    fakeTrackClient(SHOP_SUMMARY, { mayCustomize: true, ...custom });

  it('[RPT-006] someone who may only read sees no way to change it', async () => {
    open();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Customise' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to the default' })).toBeNull();
  });

  it('[RPT-006] a viewer reads the widgets chosen, without the tools that change them', async () => {
    open('en', fakeTrackClient(SHOP_SUMMARY, { custom: CUSTOM }));
    expect(await screen.findByRole('article', { name: 'Open bugs' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'SHOP-41' })).toBeVisible();
    expect(screen.getByText('Releases go out on Thursdays.')).toBeVisible();
    expect(await screen.findByRole('link', { name: '26' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Customise' })).toBeNull();
  });

  it('[RPT-006] customizing starts from today’s numbers, so nothing is lost', async () => {
    const user = userEvent.setup();
    const { client } = open('en', customizable());
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    const numbers = await screen.findByRole('article', { name: 'This track’s numbers' });
    expect(await within(numbers).findByRole('link', { name: '26' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save the summary' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.saved).toEqual([
      {
        layout: 'one',
        widgets: [{ kind: 'track-summary', column: 0, title: '', config: {} }],
      },
    ]);
    expect(screen.getByRole('button', { name: 'Back to the default' })).toBeVisible();
  });

  it('[RPT-005] [RPT-006] adds a widget with the settings of its kind, an empty query meaning the track', async () => {
    const user = userEvent.setup();
    const { client } = open('en', customizable());
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layout' }), 'Two columns');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Widget to add' }),
      'Created vs closed',
    );
    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    const form = await screen.findByRole('form', { name: /Created vs closed/ });
    expect(within(form).getByRole('textbox', { name: /query/i })).toHaveAttribute(
      'placeholder',
      'Empty for this track',
    );
    await user.click(within(form).getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Save the summary' }));
    await screen.findByRole('status');
    expect(client.saved).toEqual([
      {
        layout: 'two',
        widgets: [
          expect.objectContaining({ kind: 'created-vs-closed', config: expect.anything() }),
          { kind: 'track-summary', column: 0, title: '', config: {} },
        ],
      },
    ]);
  });

  it('[RPT-002] [RPT-006] adds a workload as a pie, by the measure chosen, for the open tickets only', async () => {
    const user = userEvent.setup();
    const { client } = open('en', customizable());
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Widget to add' }), 'Workload');
    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    const form = await screen.findByRole('form', { name: /Workload/ });
    expect(within(form).getByRole('checkbox', { name: 'Open tickets only' })).toBeChecked();
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Measure' }), 'Time spent');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Show as' }), 'Pie chart');
    await user.click(within(form).getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Save the summary' }));
    await screen.findByRole('status');
    expect(client.saved).toEqual([
      {
        layout: 'one',
        widgets: [
          {
            kind: 'workload',
            column: 0,
            title: '',
            config: {
              query: '',
              field: 'assignee',
              statistic: 'timeSpent',
              open: true,
              view: 'pie',
            },
          },
          { kind: 'track-summary', column: 0, title: '', config: {} },
        ],
      },
    ]);
  });

  it('[RPT-006] moves and removes widgets, keeping the version it read', async () => {
    const user = userEvent.setup();
    const { client } = open('en', customizable({ custom: CUSTOM }));
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    await user.click(
      await screen.findByRole('button', { name: /Open bugs.*left|left.*Open bugs/i }),
    );
    await user.click(screen.getByRole('button', { name: /Remove.*Introduction/i }));
    await user.click(screen.getByRole('button', { name: 'Save the summary' }));
    await screen.findByRole('status');
    expect(client.saved).toEqual([
      expect.objectContaining({
        layout: 'two',
        version: 3,
        widgets: [
          expect.objectContaining({ id: 'w-numbers', column: 0 }),
          expect.objectContaining({ id: 'w-open', column: 0 }),
        ],
      }),
    ]);
  });

  it('[RPT-006] says when someone else changed it, or when the server refuses', async () => {
    const user = userEvent.setup();
    const stale = customizable({ custom: CUSTOM, saveError: 'version_conflict' });
    const first = open('en', stale);
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    await user.click(screen.getByRole('button', { name: 'Save the summary' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed this summary');
    first.container.remove();
    const refused = customizable({ custom: CUSTOM, saveError: 'forbidden' });
    const second = open('en', refused);
    await user.click(await within(second.container).findByRole('button', { name: 'Customise' }));
    await user.click(within(second.container).getByRole('button', { name: 'Save the summary' }));
    expect(await within(second.container).findByRole('alert')).toHaveTextContent(
      'Only the track’s owner and administrators',
    );
  });

  /** A Summary its owner customized, counting the times it was sent back to the default. */
  const resettable = (refuse = false) => {
    const client = customizable({ custom: CUSTOM });
    const resets: string[] = [];
    const reset = client.resetSummaryLayout;
    client.resetSummaryLayout = async (key) => {
      resets.push(key);
      if (refuse) throw new Error('forbidden');
      await reset(key);
    };
    return { client, resets };
  };
  const OUTCOME =
    'The summary of Shop returns to the default for everyone, and the widgets chosen for it are removed. This cannot be undone.';

  it('[RPT-006] [NFR-005] asks first, saying the summary returns to the default for everyone', async () => {
    const user = userEvent.setup();
    const { client, resets } = resettable();
    open('en', client);
    const back = await screen.findByRole('button', { name: 'Back to the default' });
    expect(back).toHaveClass('button-danger-quiet');
    await user.click(back);
    const question = screen.getByRole('group', { name: OUTCOME });
    expect(within(question).getByRole('button', { name: 'Reset the summary of Shop' })).toHaveClass(
      'button-danger',
    );
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // Cancel and Escape send nothing, keep the widgets and give focus back to the button.
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Back to the default' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back to the default' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: OUTCOME })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to the default' })).toHaveFocus();
    expect(resets).toEqual([]);
    expect(screen.getByRole('article', { name: 'Open bugs' })).toBeVisible();
  });

  it('[RPT-006] [NFR-005] goes back to the default on the named answer, focus on the heading', async () => {
    const user = userEvent.setup();
    const { client, resets } = resettable();
    open('en', client);
    await user.click(await screen.findByRole('button', { name: 'Back to the default' }));
    await user.click(screen.getByRole('button', { name: 'Reset the summary of Shop' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'This track shows its default summary again.',
    );
    expect(resets).toEqual(['SHOP']);
    expect(screen.queryByRole('article', { name: 'Open bugs' })).toBeNull();
    expect(await screen.findByRole('region', { name: 'Open by priority' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Back to the default' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Summary' })).toHaveFocus(),
    );
  });

  it('[RPT-006] [NFR-005] keeps the question open on a refusal, saying why', async () => {
    const user = userEvent.setup();
    const { client, resets } = resettable(true);
    open('en', client);
    await user.click(await screen.findByRole('button', { name: 'Back to the default' }));
    await user.click(screen.getByRole('button', { name: 'Reset the summary of Shop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the track’s owner and administrators',
    );
    expect(resets).toEqual(['SHOP']);
    expect(screen.getByRole('group', { name: OUTCOME })).toBeVisible();
    expect(screen.getByRole('article', { name: 'Open bugs' })).toBeVisible();
  });

  it('[RPT-006] asks in Spanish', async () => {
    const user = userEvent.setup();
    const { client } = resettable();
    open('es', client);
    await user.click(await screen.findByRole('button', { name: 'Volver al predeterminado' }));
    expect(
      screen.getByRole('group', {
        name: 'El resumen de Shop vuelve al predeterminado para todos, y se quitan los widgets elegidos para él. No se puede deshacer.',
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restablecer el resumen de Shop' })).toBeVisible();
  });

  it('[RPT-006] explains a summary with no widgets', async () => {
    open('en', fakeTrackClient(SHOP_SUMMARY, { custom: { ...CUSTOM, widgets: [] } }));
    expect(await screen.findByText('No widgets on this summary')).toBeVisible();
  });

  it('[RPT-006] fits a phone while customizing, without sideways scrolling', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    open('en', customizable({ custom: CUSTOM }));
    await user.click(await screen.findByRole('button', { name: 'Customise' }));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

describe('filtering a track summary for oneself (RPT-006; T-075a)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#/tracks/SHOP');
  });
  afterEach(() => {
    window.history.replaceState(null, '', '#/');
    setViewportWidth(1280);
  });
  const MINE = 'assignee = currentUser()';

  it('[RPT-006] a member narrows every number to their tickets, each still opening its search', async () => {
    const user = userEvent.setup();
    const { client } = open();
    expect(await screen.findByRole('link', { name: '26' })).toBeVisible();
    // A member reads it and may filter it, but not customize it.
    expect(screen.queryByRole('button', { name: 'Customise' })).toBeNull();
    const form = screen.getByRole('form', { name: 'Filter this summary for yourself' });
    await user.click(within(form).getByRole('button', { name: 'My tickets' }));
    // The filter is in the page's address, the person's own.
    await waitFor(() =>
      expect(window.location.hash).toBe(
        `#/tracks/SHOP?${new URLSearchParams({ filter: MINE }).toString()}`,
      ),
    );
    const open8 = await screen.findByRole('link', { name: '8' });
    expect(open8).toHaveAttribute(
      'href',
      `#/search?${new URLSearchParams({ q: `track = SHOP AND ${MINE} AND closeReason IS EMPTY` }).toString()}`,
    );
    expect(within(form).getByLabelText('Only tickets that match')).toHaveValue(MINE);
    expect(within(form).getByText(`Showing only the tickets that match ${MINE}.`)).toBeVisible();
    // Only the viewer's view changes, and the link can be shared (T-264).
    expect(within(form).getByText(/This filter changes only your view/)).toBeVisible();
    expect(within(form).getByText(/share the link/)).toBeVisible();
    expect(client.filters).toEqual(['', MINE]);
    // Nothing was saved for anyone.
    expect(client.saved).toEqual([]);

    await user.click(within(form).getByRole('button', { name: 'Clear the filter' }));
    expect(await screen.findByRole('link', { name: '26' })).toBeVisible();
    expect(window.location.hash).toBe('#/tracks/SHOP');
    expect(within(form).getByLabelText('Only tickets that match')).toHaveValue('');
  });

  it('[RPT-006] reads the filter from the address, and checks a typed one like a search', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '#/tracks/SHOP?filter=type%20%3D%20Bug');
    const checked: string[] = [];
    const client = fakeTrackClient();
    render(
      <I18nProvider locale="en">
        <TrackSummaryPage
          trackKey="SHOP"
          client={client}
          checkQuery={async (q) => {
            checked.push(q);
            return !q.includes('==');
          }}
        />
      </I18nProvider>,
    );
    expect(await screen.findByRole('link', { name: '8' })).toBeVisible();
    expect(client.filters).toEqual(['type = Bug']);
    const field = screen.getByLabelText('Only tickets that match');
    expect(field).toHaveValue('type = Bug');

    await user.clear(field);
    await user.type(field, 'priority == High{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That filter does not read as a search.',
    );
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(checked).toEqual(['priority == High']);
    // Refused: the address and the numbers stay as they were.
    expect(window.location.hash).toBe('#/tracks/SHOP?filter=type%20%3D%20Bug');
    expect(client.filters).toEqual(['type = Bug']);

    await user.clear(field);
    await user.type(field, ' priority = High {Enter}');
    await waitFor(() => expect(client.filters).toEqual(['type = Bug', 'priority = High']));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[RPT-006] narrows a customized summary’s widgets too, and the owner customizes it unfiltered', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `#/tracks/SHOP?filter=${encodeURIComponent(MINE)}`);
    const client = fakeTrackClient(SHOP_SUMMARY, { mayCustomize: true, custom: CUSTOM });
    open('en', client);
    expect(await screen.findByRole('link', { name: 'SHOP-41' })).toBeVisible();
    // The numbers widget and the list both read with the filter.
    await waitFor(() => expect(client.filters.filter((f) => f === MINE)).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Customise' }));
    // While customizing, the widgets read as everyone will see them, and the filter steps aside.
    expect(screen.queryByRole('form', { name: 'Filter this summary for yourself' })).toBeNull();
    await waitFor(() => expect(client.filters.at(-1)).toBe(''));
    await user.click(screen.getByRole('button', { name: 'Save the summary' }));
    await screen.findByText('Saved.');
    // What is saved for everyone holds no filter.
    expect(JSON.stringify(client.saved)).not.toContain('currentUser');
    // The person's filter is still theirs afterwards.
    expect(screen.getByLabelText('Only tickets that match')).toHaveValue(MINE);
  });

  it('[RPT-006] says sprint widgets keep their whole sprint under a filter', async () => {
    window.history.replaceState(null, '', `#/tracks/SHOP?filter=${encodeURIComponent(MINE)}`);
    const sprint = {
      id: 'sb',
      kind: 'sprint-burndown' as const,
      column: 0,
      title: 'Our burndown',
      config: {},
    };
    open(
      'en',
      fakeTrackClient(SHOP_SUMMARY, {
        custom: { layout: 'two', version: 1, widgets: [...CUSTOM_WIDGETS, sprint] },
      }),
    );
    expect(await screen.findByText(/Sprint widgets still show their whole sprint\./)).toBeVisible();
  });

  it('[RPT-006] keeps what else the address says, and fits a phone', async () => {
    expect(routeWithFilter('#/tracks/SHOP?x=1', 'type = Bug')).toBe(
      '#/tracks/SHOP?x=1&filter=type+%3D+Bug',
    );
    expect(routeWithFilter('#/tracks/SHOP?filter=a&x=1', '')).toBe('#/tracks/SHOP?x=1');
    expect(filterOfRoute('#/tracks/SHOP?filter=+type+%3D+Bug+')).toBe('type = Bug');
    expect(filterOfRoute('#/tracks/SHOP')).toBe('');
    setViewportWidth(375);
    window.history.replaceState(null, '', `#/tracks/SHOP?filter=${encodeURIComponent(MINE)}`);
    open();
    await screen.findByRole('link', { name: '8' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

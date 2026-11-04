import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import type { PlanSection } from './address';
import { type FakePlanOptions, fakePlanClient, manyPlanItems } from './fixtures';
import { PlanPage } from './PlanPage';

function renderPlan(section: PlanSection, hash: string, options: FakePlanOptions = {}) {
  window.location.hash = hash;
  const client = fakePlanClient(options);
  const search = fakeListSearch();
  const list = fakeListClient(search);
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section={section}
        client={client}
        search={search}
        list={list}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return { client, search };
}
const itemOf = (client: ReturnType<typeof fakePlanClient>, key: string) =>
  client.items().find((i) => i.key === key);

afterEach(() => {
  window.location.hash = '';
});

describe('a Multi-track plan (PLN-001, PLN-012)', () => {
  it('[PLN-012] shows the Summary with every number linked to the search that finds it', async () => {
    renderPlan('summary', '#/plans/12');
    expect(await screen.findByRole('heading', { name: 'Spring launch' })).toBeVisible();
    const tabs = within(screen.getByRole('navigation', { name: 'Sections of Spring launch' }));
    expect(tabs.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Summary',
      'Timeline',
      'List',
      'Calendar',
      'Capacity',
      'Settings',
    ]);
    const searched = (link: HTMLElement) =>
      new URLSearchParams((link.getAttribute('href') ?? '').split('?')[1]).get('q');
    const total = await screen.findByRole('link', { name: '5 tickets in this plan' });
    expect(searched(total)).toBe('track IN ("SHOP", "OPS") OR (track = PLB AND due IS NOT EMPTY)');
    const shop = screen.getByRole('link', { name: 'SHOP 3, open the search' });
    expect(searched(shop)).toBe(
      '(track IN ("SHOP", "OPS") OR (track = PLB AND due IS NOT EMPTY)) AND track = "SHOP"',
    );
    expect(screen.getByRole('link', { name: 'Ana Ruiz 2, open the search' })).toBeVisible();
  });

  it('[PLN-001] says when sources are hidden from the viewer or no longer run, and never names a hidden one', async () => {
    renderPlan('summary', '#/plans/12', { hidden: 2, editable: false });
    expect(
      await screen.findByText(
        '2 sources of this plan are hidden from you, so they add nothing here.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('The saved search “Old import” no longer runs for you, so it is left out.'),
    ).toBeVisible();
    // Only editors see Settings.
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('[PLN-001] finds nothing when the viewer may see none of its sources', async () => {
    const { client } = renderPlan('timeline', '#/plans/12/timeline', { hidden: 'all' });
    expect(
      await screen.findByText(
        'You cannot see any of this plan’s sources, so it shows nothing for you.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'SHOP-2' })).toBeNull();
    expect((await client.timeline(12, {})).items).toEqual([]);
  });

  it('[PLN-012] opens the view the address holds: filtered and grouped, and a change goes to the address', async () => {
    const user = userEvent.setup();
    renderPlan('timeline', '#/plans/12/timeline?assignee=me&group=track');
    // Ana's tickets only, under a heading per track.
    expect(await screen.findByText('SHOP · Shop (1)')).toBeVisible();
    expect(screen.getByText('OPS · Operations (1)')).toBeVisible();
    expect(screen.getByRole('link', { name: 'SHOP-2' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'OPS-4' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'SHOP-3' })).toBeNull();
    expect(screen.getByLabelText('Assignee')).toHaveValue('me');
    expect(screen.getByLabelText('Group by')).toHaveValue('track');
    await user.click(screen.getByRole('button', { name: 'Hide the tickets of SHOP · Shop' }));
    expect(screen.queryByRole('link', { name: 'SHOP-2' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Stage'), 'active');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/plans/12/timeline?assignee=me&stage=active&group=track'),
    );
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/timeline?group=track'));
  });

  it('[PLN-012] reschedules across tracks from the timeline, and rolls the outcome up again', async () => {
    const user = userEvent.setup();
    const { client } = renderPlan('timeline', '#/plans/12/timeline');
    expect(
      await screen.findByRole('img', {
        name: 'SHOP-1: Nov 2, 2026 to Nov 20, 2026, rolled up from its children',
      }),
    ).toBeVisible();
    const bar = screen.getByRole('button', { name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026' });
    bar.focus();
    await user.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}');
    await waitFor(() =>
      expect(itemOf(client, 'SHOP-3')).toMatchObject({ start: '2026-11-16', due: '2026-11-27' }),
    );
    expect(
      await screen.findByRole('img', {
        name: 'SHOP-1: Nov 2, 2026 to Nov 27, 2026, rolled up from its children',
      }),
    ).toBeVisible();
    // The blocking link from SHOP-2 to OPS-4 crosses the tracks.
    await user.click(screen.getByRole('button', { name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026' }));
    expect(
      within(screen.getByRole('complementary', { name: 'Days of OPS-4' })).getByText(
        'Blocked by SHOP-2',
      ),
    ).toBeVisible();
  });

  it('[PLN-012] says in plain words why a change was refused', async () => {
    const user = userEvent.setup();
    renderPlan('timeline', '#/plans/12/timeline', { refuse: 'track_archived' });
    const bar = await screen.findByRole('button', { name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026' });
    bar.focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'OPS-4 could not be rescheduled: its track is archived.',
    );
  });

  it('[PLN-012] says a lock is a lock, not a missing permission', async () => {
    const user = userEvent.setup();
    renderPlan('timeline', '#/plans/12/timeline', {
      refuse: { code: 'forbidden', permission: 'edit', locked: true },
    });
    const bar = await screen.findByRole('button', { name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026' });
    bar.focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'OPS-4 could not be rescheduled: its status or its dates are locked for you.',
    );
  });

  it('[PLN-001] does not say the sources are hidden when they are seen but none can be searched', async () => {
    renderPlan('summary', '#/plans/12', { archivedOnly: true });
    expect(
      await screen.findByText(
        'None of this plan’s sources can be searched now: archived tracks and saved searches that no longer run add nothing.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('The track Shop is archived, so its tickets are not shown.'),
    ).toBeVisible();
    expect(
      screen.queryByText('You cannot see any of this plan’s sources, so it shows nothing for you.'),
    ).toBeNull();
  });

  it('[PLN-012] runs no view with the last filters when the plan for new ones fails to load', async () => {
    const user = userEvent.setup();
    const { search } = renderPlan('list', '#/plans/12/list', {
      failOn: (filters) => filters.assignee === 'me',
    });
    expect(await screen.findByRole('region', { name: 'Tickets' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Assignee'), 'me');
    expect(await screen.findByRole('alert')).toHaveTextContent('This plan could not be loaded.');
    expect(screen.queryByRole('region', { name: 'Tickets' })).toBeNull();
    // Nothing searched without the filter the address now holds.
    const before = search.queries.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(search.queries.length).toBe(before);
  });

  it('[PLN-012] lists at most the first 10,000 tickets on the timeline and says so', async () => {
    renderPlan('timeline', '#/plans/12/timeline', { items: manyPlanItems(10_001) });
    expect(
      await screen.findByText(
        'Only the first 10,000 tickets are shown. Filter the plan to see the rest.',
        {},
        { timeout: 10_000 },
      ),
    ).toBeVisible();
    // Only the rows in view are drawn.
    expect(document.querySelectorAll('.timeline-row').length).toBeLessThan(200);
  }, 20_000);

  it('[PLN-012] lists the plan as a search, grouped by track', async () => {
    const { search } = renderPlan('list', '#/plans/12/list?group=track');
    expect(await screen.findByRole('heading', { name: 'SHOP (2 tickets)' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'OPS (1 ticket)' })).toBeVisible();
    await waitFor(() =>
      expect(search.queries).toContain(
        '(track IN ("SHOP", "OPS") OR (track = PLB AND due IS NOT EMPTY)) AND track = 1 ORDER BY created DESC',
      ),
    );
  });

  it('[PLN-012] moves a ticket on the calendar from the keyboard', async () => {
    const user = userEvent.setup();
    const { client } = renderPlan('calendar', '#/plans/12/calendar');
    const chip = await screen.findByRole('link', {
      name: 'OPS-4 Scale the servers, due this day',
    });
    chip.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() =>
      expect(itemOf(client, 'OPS-4')).toMatchObject({ start: '2026-11-13', due: '2026-11-19' }),
    );
    expect(await screen.findByText('OPS-4 is now due on Nov 19, 2026.')).toBeVisible();
  });

  it('[PLN-012] offers clearing the filters when the address holds one that does not read', async () => {
    renderPlan('summary', '#/plans/12?track=NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('These filters cannot be used here');
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      expect.stringContaining('/plans/12'),
    );
  });

  it('[PLN-001] saves its name, sources and who sees it, and says when someone changed it meanwhile', async () => {
    const user = userEvent.setup();
    const { client } = renderPlan('settings', '#/plans/12/settings');
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Spring');
    await user.click(await screen.findByRole('checkbox', { name: 'DATA · Data' }));
    await user.selectOptions(screen.getByLabelText('Who sees it'), 'any_user');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(client.saved.at(-1)).toMatchObject({
      name: 'Spring',
      sources: [
        { kind: 'track', trackId: 1 },
        { kind: 'track', trackId: 2 },
        { kind: 'savedSearch', savedSearchId: 30 },
        { kind: 'savedSearch', savedSearchId: 31 },
        { kind: 'track', trackId: 3 },
      ],
      shares: [{ scope: 'any_user' }],
      version: 1,
    });
    // Someone else changes it; a save from the version read before is refused.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Spring' })).toBeVisible());
    await client.update(12, { name: 'Spring, theirs', version: 2 });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone changed this plan meanwhile',
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Delete plan' }));
    await waitFor(() => expect(client.removed).toEqual([12]));
  });

  it('[PLN-012] fits a phone: no sideways scroll, filters stacked', async () => {
    setViewportWidth(375);
    renderPlan('timeline', '#/plans/12/timeline?group=assignee');
    expect(await screen.findByText('Ana Ruiz (2)')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

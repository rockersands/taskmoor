import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { type FakePlanOptions, fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

/** A plan's Releases tab (T-089c; PLN-007, PLN-001; ADR-122 stage 4), with the fixture plan. */
function renderTab(
  hash = '#/plans/12/releases',
  options: FakePlanOptions = {},
  client = fakePlanClient(options),
) {
  window.location.hash = hash;
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section="releases"
        client={client}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return client;
}

describe('a plan’s Releases tab (PLN-007)', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('[PLN-007] [PLN-001] gathers linked releases under theirs, then the rest by track, and only counts what is hidden', async () => {
    renderTab();
    const group = await screen.findByRole('region', { name: 'Launch across tracks' });
    expect(
      within(group).getByRole('link', { name: 'Launch across tracks' }).getAttribute('href'),
    ).toContain('#/cross-track-releases/5');
    expect(within(group).getByRole('link', { name: 'Shop 2.0' })).toBeVisible();
    expect(within(group).getByText('Out of step')).toBeVisible();
    expect(within(group).getByText(/Due on Dec 1, 2026/)).toBeVisible();
    expect(
      within(group).getByText(
        '1 more release is hidden from you, with 4 open tickets you may not see.',
      ),
    ).toBeVisible();
    const operations = screen.getByRole('region', { name: 'Operations' });
    expect(within(operations).getByRole('link', { name: 'Ops 1.5' })).toBeVisible();
  });

  it('[PLN-007] says only the track filter applies', async () => {
    renderTab('#/plans/12/releases?assignee=me');
    expect(
      await screen.findByText(
        'Only the track filter applies here: a release has no assignee, type or stage.',
      ),
    ).toBeVisible();
  });

  it('[PLN-007] takes the track filter to the server', async () => {
    const client = fakePlanClient();
    const releases = vi.spyOn(client, 'releases');
    renderTab('#/plans/12/releases?track=OPS', {}, client);
    expect(await screen.findByRole('region', { name: 'Operations' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Launch across tracks' })).toBeNull();
    expect(releases).toHaveBeenLastCalledWith(12, 'OPS');
  });

  it('[PLN-007] has the way to every release across tracks, with none in this plan too', async () => {
    renderTab('#/plans/12/releases?track=OPS');
    expect(await screen.findByRole('link', { name: 'Releases across tracks' })).toHaveAttribute(
      'href',
      expect.stringMatching(/#\/cross-track-releases$/),
    );
  });

  it('[PLN-007] has its place in the tab bar, after Capacity', async () => {
    renderTab();
    const nav = await screen.findByRole('navigation', { name: /Sections of|sections/i });
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(names.slice(names.indexOf('Capacity'), names.indexOf('Capacity') + 2)).toEqual([
      'Capacity',
      'Releases',
    ]);
  });

  it('[PLN-007] says when a shipped release shipped, and lists each group by date (PL-40)', async () => {
    const client = fakePlanClient();
    const read = client.releases;
    client.releases = async (id, track) => {
      const answer = await read(id, track);
      const ops = answer.tracks[0];
      const shipped = { shipped: true, archived: false, overdue: false, outOfStep: false };
      const progress = { tickets: 2, closed: 2, open: 0 };
      // As the server sends them: upcoming first, then shipped, then one with no date.
      ops?.releases.push(
        { id: 24, name: 'Ops 0.9', releaseDate: null, ...shipped, shipped: false, progress },
        { id: 25, name: 'Ops 1.0', releaseDate: '2026-08-18', ...shipped, progress },
      );
      return answer;
    };
    renderTab(undefined, {}, client);
    const operations = await screen.findByRole('region', { name: 'Operations' });
    expect(
      within(operations)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Ops 1.0', 'Ops 1.5', 'Ops 0.9']);
    expect(within(operations).getByText('Shipped on Aug 18, 2026')).toBeVisible();
    expect(within(operations).getByText('Due on Jan 15, 2027')).toBeVisible();
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { withCriticalPath } from '../timeline/criticalFixtures';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

/**
 * The critical path on a plan's Timeline (PLN-011; ADR-122 stage 9), with the fixture plan: the
 * server's path is SHOP-2 (two days late against SHOP-3) and SHOP-3, which ends the plan on 20 Nov;
 * OPS-4 has two days of slack.
 */
function renderTimeline(hash = '#/plans/12/timeline') {
  window.location.hash = hash;
  const client = withCriticalPath(fakePlanClient());
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section="timeline"
        client={client}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return client;
}

afterEach(() => {
  window.location.hash = '';
});

describe('the critical path of a plan (PLN-011)', () => {
  it('[PLN-011] turns on from the tools, keeps it in the address, marks the bars and gives the path in words', async () => {
    const user = userEvent.setup();
    const client = renderTimeline();
    const toggle = await screen.findByRole('button', { name: 'Critical path', pressed: false });
    expect(client.pathReads).toEqual([]);
    await user.click(toggle);
    await waitFor(() => expect(window.location.hash).toContain('critical=1'));
    expect(
      await screen.findByRole('button', {
        name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026',
        description: /On the critical path$/,
      }),
    ).toHaveClass('is-critical');
    expect(
      screen.getByRole('button', {
        name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026',
        description: /2 days of slack$/,
      }),
    ).not.toHaveClass('is-critical');
    const list = screen.getByRole('region', { name: 'Critical path' });
    expect(
      within(list).getByText('2 tickets are on the critical path. The plan ends Nov 20, 2026.'),
    ).toBeVisible();
    // A button beside the tools reaches the list at once.
    await user.click(screen.getByRole('button', { name: 'Critical path in words' }));
    expect(within(list).getByRole('heading', { name: 'Critical path' })).toHaveFocus();
    // Off again: the marks and the list go, and so does the address's flag.
    await user.click(screen.getByRole('button', { name: 'Critical path', pressed: true }));
    await waitFor(() => expect(window.location.hash).not.toContain('critical=1'));
    expect(screen.queryByRole('region', { name: 'Critical path' })).toBeNull();
    expect(document.querySelector('.timeline-bar.is-critical')).toBeNull();
  });

  it('[PLN-011] opens with it on from a link, and asks with the filters only for the tickets it lists', async () => {
    const client = renderTimeline('#/plans/12/timeline?assignee=me&critical=1');
    expect(await screen.findByRole('region', { name: 'Critical path' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Critical path', pressed: true })).toBeVisible();
    expect(client.pathReads[0]?.filters).toEqual({ assignee: 'me' });
  });

  it('[PLN-011] says so when the path cannot be read, and the timeline stays', async () => {
    window.location.hash = '#/plans/12/timeline?critical=1';
    const client = withCriticalPath(fakePlanClient(), async () => {
      throw new Error('offline');
    });
    const search = fakeListSearch();
    render(
      <I18nProvider locale="en">
        <PlanPage
          id={12}
          section="timeline"
          client={client}
          search={search}
          list={fakeListClient(search)}
          now={() => new Date('2026-11-04T09:00:00Z')}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText(/The critical path could not be read/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026' }),
    ).toBeVisible();
  });
});

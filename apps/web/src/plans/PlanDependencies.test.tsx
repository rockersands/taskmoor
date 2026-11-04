import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

/**
 * The dependencies on a plan's Timeline (T-089; PLN-006; ADR-122), with the fixture plan:
 * SHOP-2 blocks SHOP-3 (late: SHOP-3 starts on Nov 9, SHOP-2 ends on Nov 10) and OPS-4 (on time),
 * OPS-4 blocks OPS-5 (no dates) and is blocked by two tickets outside the plan.
 */
function renderTimeline(hash = '#/plans/12/timeline') {
  window.location.hash = hash;
  const client = fakePlanClient();
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

const entryOf = (key: string) =>
  screen
    .getAllByRole('listitem')
    .find(
      (li) =>
        li.classList.contains('dependency-entry') &&
        li.querySelector('.dependency-ticket .dependency-key')?.textContent === key,
    ) as HTMLElement;

afterEach(() => {
  window.location.hash = '';
});

describe('the dependencies of a plan (PLN-006)', () => {
  it('[PLN-006] puts a badge on each blocked bar, red with the word "late" when a blocker is late', async () => {
    renderTimeline();
    const late = await screen.findByRole('button', {
      name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026',
      description: /Blocked by 1 ticket, 1 late$/,
    });
    const lateBadge = late.parentElement?.querySelector('.timeline-badge') as HTMLElement;
    expect(lateBadge).toHaveClass('is-late');
    expect(within(lateBadge).getByText('1 · late')).toBeVisible();
    // OPS-4: SHOP-2 on time, and two outside the plan, counted.
    const ops = screen.getByRole('button', {
      name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026',
      description: /Blocked by 3 tickets$/,
    });
    const badge = ops.parentElement?.querySelector('.timeline-badge') as HTMLElement;
    expect(badge).not.toHaveClass('is-late');
    expect(badge.textContent).toContain('3');
    // An unscheduled ticket's badge too.
    expect(
      screen.getByRole('button', {
        name: 'No dates: schedule OPS-5',
        description: 'Blocked by 1 ticket',
      }),
    ).toBeVisible();
    // A line per dependency between bars (OPS-5 has none), the late one dashed in red.
    expect(document.querySelectorAll('.timeline-link')).toHaveLength(2);
    expect(document.querySelectorAll('.timeline-link.is-late')).toHaveLength(1);
  });

  it('[PLN-006] lists the same for the keyboard and screen readers, and a button goes there', async () => {
    const user = userEvent.setup();
    renderTimeline();
    const go = await screen.findByRole('button', { name: 'List of dependencies' });
    await user.click(go);
    const heading = screen.getByRole('heading', { name: 'Dependencies' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('3 tickets have blockers; 1 dependency is late.')).toBeVisible();
    expect(entryOf('SHOP-3')).toHaveTextContent(
      'SHOP-2 Build the shop page Late: it ends Nov 10, 2026, but SHOP-3 starts Nov 9, 2026.',
    );
    const ops = entryOf('OPS-4');
    expect(ops).toHaveTextContent(
      'On time: it ends Nov 10, 2026, before OPS-4 starts Nov 12, 2026.',
    );
    expect(within(ops).getByText('2 tickets outside this plan')).toBeVisible();
    expect(entryOf('OPS-5')).toHaveTextContent('No dates: one of the two has no dates to compare.');
  });

  it('[PLN-006] counts the plan’s own blockers that a filter leaves out, apart from those outside', async () => {
    // SHOP-2 is active: with stage=new it is not listed, so it blocks SHOP-3 and OPS-4 unseen.
    renderTimeline('#/plans/12/timeline?stage=new');
    await screen.findByRole('link', { name: 'SHOP-3' });
    expect(entryOf('SHOP-3')).toHaveTextContent('1 ticket of this plan not shown here');
    const ops = entryOf('OPS-4');
    expect(within(ops).getByText('2 tickets outside this plan')).toBeVisible();
    expect(within(ops).getByText('1 ticket of this plan not shown here')).toBeVisible();
    expect(within(ops).queryByRole('link', { name: /SHOP-2/ })).toBeNull();
    // OPS-4 still blocks OPS-5, listed: a badge and an entry, and no line to a ticket without days.
    expect(entryOf('OPS-5')).toHaveTextContent('OPS-4 Scale the servers No dates:');
    expect(document.querySelectorAll('.timeline-link')).toHaveLength(0);
  });

  it('[PLN-006] clears the late state once the blocked ticket is moved after its blocker', async () => {
    const user = userEvent.setup();
    const client = renderTimeline();
    const bar = await screen.findByRole('button', { name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026' });
    bar.focus();
    await user.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}');
    await waitFor(() =>
      expect(client.items().find((i) => i.key === 'SHOP-3')?.start).toBe('2026-11-16'),
    );
    await waitFor(() =>
      expect(document.querySelectorAll('.timeline-link.is-late')).toHaveLength(0),
    );
    expect(
      screen.getByRole('button', {
        name: 'SHOP-3: Nov 16, 2026 to Nov 27, 2026',
        description: /Blocked by 1 ticket$/,
      }),
    ).toBeVisible();
    expect(screen.getByText('3 tickets have blockers; none is late.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Only late ones' })).toBeNull();
  });

  it('[PLN-006] says in the side panel which blockers are late and how many are elsewhere', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await user.click(
      await screen.findByRole('button', { name: 'SHOP-3: Nov 9, 2026 to Nov 20, 2026' }),
    );
    const panel = within(screen.getByRole('complementary', { name: 'Days of SHOP-3' }));
    expect(panel.getByText('Blocked by SHOP-2')).toBeVisible();
    expect(panel.getByText('Late: SHOP-2')).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'OPS-4: Nov 12, 2026 to Nov 18, 2026' }));
    const ops = within(screen.getByRole('complementary', { name: 'Days of OPS-4' }));
    expect(ops.getByText('Blocked by 2 tickets outside this plan')).toBeVisible();
    expect(ops.queryByText(/^Late:/)).toBeNull();
  });

  it('[PLN-006] fits a phone: the list below the timeline, no sideways scroll', async () => {
    setViewportWidth(375);
    renderTimeline();
    expect(await screen.findByRole('region', { name: 'Dependencies' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

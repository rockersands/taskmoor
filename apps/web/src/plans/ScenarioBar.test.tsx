import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import type { PlanSection } from './address';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';

/** "Spring launch" with its main scenario and Faster, which drafts SHOP-2 due a day later. */
const TWO: NonNullable<FakeScenarioOptions['scenarios']> = [
  { name: 'Main plan', drafts: [{ ticketId: 3, dueDate: '2026-11-25' }] },
  { name: 'Faster', drafts: [{ ticketId: 2, dueDate: '2026-11-11' }] },
];

function renderPlan(section: PlanSection, hash: string, options: FakeScenarioOptions = {}) {
  window.location.hash = hash;
  const plans = fakePlanClient();
  const scenarios = fakeScenarioClient(plans, { scenarios: TWO, ...options });
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section={section}
        client={plans}
        scenarios={scenarios}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return { plans, scenarios };
}

afterEach(() => {
  window.location.hash = '';
});

describe('the scenario bar (ADR-122 stage 6)', () => {
  it('[PLN-002] opens a plan Live, and says that a change there changes tickets now', async () => {
    const { plans } = renderPlan('timeline', '#/plans/12/timeline');
    const select = await screen.findByRole('combobox', { name: 'Scenario' });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveDisplayValue('Live');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Live', 'Main plan (main)', 'Faster', 'New scenario…']);
    expect(select).toHaveAccessibleDescription('Changes you make here change tickets now.');
    await screen.findByRole('button', { name: /^SHOP-2: / });
    expect(plans.scenarioReads.every((s) => s === undefined)).toBe(true);
  });

  it('[PLN-002] keeps the chosen scenario in the address, says what an edit does there and announces the change', async () => {
    const user = userEvent.setup();
    const { plans } = renderPlan('timeline', '#/plans/12/timeline?track=SHOP');
    const select = await screen.findByRole('combobox', { name: 'Scenario' });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'Faster');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/plans/12/timeline?track=SHOP&scenario=2'),
    );
    await waitFor(() =>
      expect(screen.getByText('Now showing Faster: drafts, not applied.')).toBeInTheDocument(),
    );
    expect(select).toHaveAccessibleDescription(
      'Drafting in Faster: 1 change. Nothing changes tickets until you apply them.',
    );
    expect(screen.getByRole('link', { name: 'Review 1 change' })).toHaveAttribute(
      'href',
      '#/plans/12/changes?track=SHOP&scenario=2',
    );
    // The Timeline reads the scenario: SHOP-2 is due on its drafted day, marked in words.
    expect(
      await screen.findByRole('button', {
        name: 'SHOP-2, draft: Nov 2, 2026 to Nov 11, 2026. Now Nov 2, 2026 to Nov 10, 2026.',
      }),
    ).toBeVisible();
    expect(plans.scenarioReads).toContain(2);
    // Back to Live: said too.
    await user.selectOptions(select, 'Live');
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/timeline?track=SHOP'));
    await screen.findByText('Now showing the plan live.');
  });

  it('[PLN-002] tells someone who may not draft that they are only viewing, and offers no new scenario', async () => {
    renderPlan('timeline', '#/plans/12/timeline?scenario=2', { editable: false });
    const select = await screen.findByRole('combobox', { name: 'Scenario' });
    await waitFor(() =>
      expect(select).toHaveAccessibleDescription(
        'Viewing Faster. Only the plan’s owner and site administrators can draft.',
      ),
    );
    expect(within(select).queryByRole('option', { name: 'New scenario…' })).toBeNull();
  });

  it('[PLN-002] counts drafts on tickets the plan does not show, never naming them', async () => {
    renderPlan('timeline', '#/plans/12/timeline?scenario=2', { notShown: { Faster: 3 } });
    const select = await screen.findByRole('combobox', { name: 'Scenario' });
    await waitFor(() =>
      expect(select).toHaveAccessibleDescription(
        'Drafting in Faster: 1 change. Nothing changes tickets until you apply them. 3 more changes are on tickets this plan does not show you.',
      ),
    );
  });

  it('[PLN-002] shows the plan live, and says so, when the scenario in the address no longer exists', async () => {
    const { plans } = renderPlan('timeline', '#/plans/12/timeline?scenario=9');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That scenario no longer exists, so this is the plan live.',
    );
    await screen.findByRole('button', { name: /^SHOP-2: / });
    expect(plans.scenarioReads.every((s) => s === undefined)).toBe(true);
  });

  it('[PLN-003] makes a new scenario from the select and opens it', async () => {
    const user = userEvent.setup();
    renderPlan('timeline', '#/plans/12/timeline');
    const select = await screen.findByRole('combobox', { name: 'Scenario' });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'New scenario…');
    const dialog = await screen.findByRole('dialog', { name: 'New scenario' });
    // The select still says what the page reads.
    expect(select).toHaveDisplayValue('Live');
    await user.type(within(dialog).getByLabelText('Name'), 'Slower');
    await user.selectOptions(
      within(dialog).getByLabelText('Start from'),
      'A copy of Faster (1 change)',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Make scenario' }));
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/timeline?scenario=4'));
    await waitFor(() => expect(select).toHaveDisplayValue('Slower'));
  });
});

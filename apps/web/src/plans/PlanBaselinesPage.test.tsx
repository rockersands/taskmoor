import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type FakeBaselineOptions, fakeBaselineClient } from './baselineFixtures';
import { fakePlanClient } from './fixtures';
import { PlanBaselinesPage } from './PlanBaselinesPage';
import { PlanPage } from './PlanPage';
import { fakeScenarioClient } from './scenarioFixtures';

/**
 * A plan's baselines (T-089a; PLN-011; ADR-122 stage 9) on the plan's page: "Kick-off" was
 * captured from Live on 1 November; the plan has one scenario, "Faster".
 */
function renderBaselines(hash = '#/plans/12/baselines', options: FakeBaselineOptions = {}) {
  window.location.hash = hash;
  const plans = fakePlanClient();
  const scenarios = fakeScenarioClient(plans, { scenarios: [{ name: 'Faster' }] });
  const baselines = fakeBaselineClient(options);
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section="baselines"
        client={plans}
        scenarios={scenarios}
        baselines={baselines}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return { baselines };
}
const itemOf = (name: string) =>
  screen.getByRole('heading', { name, level: 3 }).closest('li') as HTMLElement;

afterEach(() => {
  window.location.hash = '';
  act(() => setViewportWidth(1440));
});

describe('a plan’s baselines (PLN-011)', () => {
  it('[PLN-011] lists each baseline with where its days came from, its tickets, who and when', async () => {
    renderBaselines('#/plans/12/baselines', {
      baselines: [
        { id: 5, name: 'Drafted', source: 'scenario', scenarioName: 'Faster' },
        { id: 1 },
      ],
    });
    expect(await screen.findByRole('heading', { name: 'Baselines', level: 2 })).toBeVisible();
    const kickOff = itemOf('Kick-off');
    expect(within(kickOff).getByText('From Live · 6 tickets')).toBeVisible();
    expect(within(kickOff).getByText(/^Captured by Ana Ruiz on /)).toBeVisible();
    expect(within(itemOf('Drafted')).getByText('From Faster · 6 tickets')).toBeVisible();
    expect(within(kickOff).getByRole('link', { name: 'Compare with Kick-off' })).toHaveAttribute(
      'href',
      '#/plans/12/baselines?baseline=1',
    );
    // The tab sits after Scenarios.
    const tabs = screen.getByRole('navigation', { name: /^Sections of / });
    const names = within(tabs)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(names.indexOf('Baselines')).toBe(names.indexOf('Scenarios') + 1);
  });

  it('[PLN-011] captures a baseline from Live with today’s name, said before it is made', async () => {
    const user = userEvent.setup();
    renderBaselines();
    await user.click(await screen.findByRole('button', { name: 'Capture baseline…' }));
    const dialog = screen.getByRole('dialog', { name: 'Capture baseline' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Baseline Nov 4');
    expect(within(dialog).getByText(/What the Timeline shows now: Live$/)).toBeVisible();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the baseline a name.');
    await user.type(within(dialog).getByLabelText('Name'), 'Before the freeze');
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await screen.findByText('Before the freeze is captured: 6 tickets.');
    await waitFor(() => expect(itemOf('Before the freeze')).toBeVisible());
  });

  it('[PLN-011] captures from the scenario open on the page', async () => {
    const user = userEvent.setup();
    const { baselines } = renderBaselines('#/plans/12/baselines?scenario=1');
    await user.click(await screen.findByRole('button', { name: 'Capture baseline…' }));
    const dialog = screen.getByRole('dialog', { name: 'Capture baseline' });
    expect(
      within(dialog).getByText(/What the Timeline shows now: Faster, drafts not applied$/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await screen.findByText('Baseline Nov 4 is captured: 6 tickets.');
    const list = await baselines.list(12);
    expect(list.baselines[0]).toMatchObject({ source: 'scenario', scenarioName: 'Faster' });
  });

  it('[PLN-011] renames and deletes a baseline, asking first', async () => {
    const user = userEvent.setup();
    renderBaselines();
    const kickOff = await waitFor(() => itemOf('Kick-off'));
    await user.click(within(kickOff).getByRole('button', { name: 'Rename Kick-off' }));
    const rename = screen.getByRole('dialog', { name: 'Rename Kick-off' });
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'Start');
    await user.click(within(rename).getByRole('button', { name: 'Save name' }));
    await screen.findByText('The baseline is now called Start.');
    const start = await waitFor(() => itemOf('Start'));
    await user.click(within(start).getByRole('button', { name: 'Delete Start' }));
    const ask = within(start).getByRole('group', {
      name: 'Start and the days it keeps go. No ticket changes.',
    });
    await user.click(within(ask).getByRole('button', { name: 'Delete Start' }));
    await screen.findByText('Start is deleted.');
    expect(await screen.findByText('No baselines yet')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Baselines', level: 2 })).toHaveFocus(),
    );
  });

  it('[PLN-011] reads the list again when a rename is refused for a change meanwhile, so the next try is saved', async () => {
    const user = userEvent.setup();
    const { baselines } = renderBaselines();
    const kickOff = await waitFor(() => itemOf('Kick-off'));
    await user.click(within(kickOff).getByRole('button', { name: 'Rename Kick-off' }));
    const rename = screen.getByRole('dialog', { name: 'Rename Kick-off' });
    // Someone else renames it while the dialog is open.
    const row = (await baselines.list(12)).baselines[0] as { version: number };
    await baselines.rename(12, 1, 'Kick-off (theirs)', row.version);
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'Start');
    await user.click(within(rename).getByRole('button', { name: 'Save name' }));
    expect(await within(rename).findByRole('alert')).toHaveTextContent(
      'Someone changed this baseline meanwhile. The list is read again; try once more.',
    );
    await waitFor(() => expect(itemOf('Kick-off (theirs)')).toBeVisible());
    await user.click(within(rename).getByRole('button', { name: 'Save name' }));
    await screen.findByText('The baseline is now called Start.');
    await waitFor(() => expect(itemOf('Start')).toBeVisible());
  });

  it('[PLN-011] turns Capture off at 10 baselines, with the reason in words', async () => {
    renderBaselines('#/plans/12/baselines', {
      baselines: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `B${i + 1}` })),
    });
    const user = userEvent.setup();
    const capture = await screen.findByRole('button', { name: 'Capture baseline…' });
    // Off, yet focusable, so its reason is in reach of the keyboard.
    expect(capture).toHaveAttribute('aria-disabled', 'true');
    expect(capture).not.toBeDisabled();
    expect(capture).toHaveAccessibleDescription(
      'A plan holds at most 10 baselines. Delete one to capture another.',
    );
    await user.click(capture);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[PLN-011] keeps focus on Capture when the tenth capture turns it off', async () => {
    const user = userEvent.setup();
    renderBaselines('#/plans/12/baselines', {
      baselines: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `B${i + 1}` })),
    });
    const capture = await screen.findByRole('button', { name: 'Capture baseline…' });
    capture.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Capture baseline' });
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await screen.findByText('Baseline Nov 4 is captured: 6 tickets.');
    await waitFor(() => expect(capture).toHaveAttribute('aria-disabled', 'true'));
    expect(capture).toHaveFocus();
  });

  it('[PLN-011] lets everyone who sees the plan read and compare, and only editors change', async () => {
    renderBaselines('#/plans/12/baselines', { editable: false });
    const kickOff = await waitFor(() => itemOf('Kick-off'));
    expect(
      screen.getByText(
        'Only the plan’s owner and site administrators capture, rename and delete baselines.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Capture baseline…' })).toBeNull();
    expect(within(kickOff).queryByRole('button', { name: /^(Rename|Delete)/ })).toBeNull();
    expect(within(kickOff).getByRole('link', { name: 'Compare with Kick-off' })).toBeVisible();
  });

  it('[PLN-011] opens the comparison from the address, against the open scenario', async () => {
    const { baselines } = renderBaselines('#/plans/12/baselines?scenario=1&baseline=1');
    expect(
      await screen.findByRole('heading', { name: 'Compared with Kick-off', level: 3 }),
    ).toBeVisible();
    expect(await screen.findByText(/^The days now: Faster, drafts not applied\./)).toBeVisible();
    expect(baselines.asked[0]).toMatchObject({ bid: 1, scenario: 1 });
    expect(screen.getByRole('link', { name: 'Close the comparison' })).toHaveAttribute(
      'href',
      '#/plans/12/baselines?scenario=1',
    );
  });

  it('[PLN-011] gives focus back to the Compare link when the comparison is closed', async () => {
    const user = userEvent.setup();
    renderBaselines('#/plans/12/baselines?baseline=1');
    await screen.findByRole('heading', { name: 'Compared with Kick-off', level: 3 });
    await user.click(screen.getByRole('link', { name: 'Close the comparison' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Compared with Kick-off' })).toBeNull(),
    );
    expect(screen.getByRole('link', { name: 'Compare with Kick-off' })).toHaveFocus();
  });

  it('[PLN-011] compares with Live, as Capture says, when the scenario in the address is gone', async () => {
    const { baselines } = renderBaselines('#/plans/12/baselines?scenario=99&baseline=1');
    expect(await screen.findByText(/^The days now: Live\./)).toBeVisible();
    expect(baselines.asked.length).toBeGreaterThan(0);
    expect(baselines.asked.every((a) => a.scenario === undefined)).toBe(true);
  });

  it('[PLN-011] says so when the baseline in the address is gone', async () => {
    renderBaselines('#/plans/12/baselines?baseline=99');
    expect(await screen.findByText('This baseline or scenario no longer exists.')).toBeVisible();
  });

  it('[NFR-006] says in Spanish that a baseline is compared later with the days as they are then', async () => {
    render(
      <I18nProvider locale="es">
        <PlanBaselinesPage
          planId={12}
          planName="Spring launch"
          client={fakeBaselineClient({ baselines: [] })}
          view={{ filters: {}, group: null }}
          scenario={null}
        />
      </I18nProvider>,
    );
    expect(
      await screen.findByText(
        'Captura una antes de que el trabajo se mueva y compárala más adelante con los días actuales.',
      ),
    ).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const errors: Error[] = [];
    const view = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <PlanBaselinesPage
          planId={12}
          planName="Spring launch"
          client={fakeBaselineClient({ notShown: 2 })}
          view={{ filters: {}, group: null, baseline: 1 }}
          scenario={null}
        />
      </I18nProvider>,
    );
    // The comparison has drawn its tickets too.
    await waitFor(() =>
      expect(view.container.querySelectorAll('.scenario-differing li')).toHaveLength(3),
    );
    // Names, keys and summaries are data, as typed.
    const data = /^(Kick-off|·|[A-Z]+-\d+|Payment form|Checkout page|Runbook)$/;
    expect(untranslated(visibleTexts(view.container).filter((x) => !data.test(x)))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

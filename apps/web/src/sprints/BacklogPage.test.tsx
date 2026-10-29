import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { BacklogPage } from './BacklogPage';
import { fakeSprintClient } from './fixtures';
import { SprintReportPage } from './SprintReportPage';

function renderBacklog(client = fakeSprintClient()) {
  render(
    <I18nProvider locale="en">
      <BacklogPage boardId={7} client={client} now={() => new Date('2026-10-29T09:00:00Z')} />
    </I18nProvider>,
  );
  return client;
}
const section = (name: string) => within(screen.getByRole('region', { name }));
const keysIn = (name: string) =>
  section(name)
    .queryAllByRole('link')
    .map((a) => a.textContent)
    .filter((text) => text?.startsWith('CHK-'));

describe('the backlog with sprint sections (M1-044)', () => {
  it('[AGL-011] shows the active sprint, the planned one and the backlog, each with its totals', async () => {
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(keysIn('Checkout Sprint 1')).toEqual(['CHK-1', 'CHK-2']);
    expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3']);
    expect(keysIn('Backlog')).toEqual(['CHK-4', 'CHK-5']);
    expect(
      section('Checkout Sprint 1').getByText('2 tickets, estimate 7h, 5h remaining'),
    ).toBeVisible();
    expect(
      section('Checkout Sprint 1').getByRole('link', { name: 'Sprint report' }),
    ).toHaveAttribute('href', '#/boards/7/sprints/11/report');
  });

  it('[AGL-008] moves a ticket into a sprint and back to the backlog with the keyboard', async () => {
    const user = userEvent.setup();
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    await user.selectOptions(
      section('Backlog').getByRole('combobox', { name: 'Move CHK-4 to' }),
      'Checkout Sprint 2',
    );
    await waitFor(() => expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-4']));
    await user.selectOptions(
      section('Checkout Sprint 2').getByRole('combobox', { name: 'Move CHK-3 to' }),
      'Backlog',
    );
    await waitFor(() => expect(keysIn('Backlog')).toEqual(['CHK-3', 'CHK-5']));
  });

  it('[AGL-010] completes the active sprint into a planned one, then starts it', async () => {
    const user = userEvent.setup();
    const client = renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    // Only one sprint may be active: starting the planned one is refused until then.
    await user.click(section('Checkout Sprint 2').getByRole('button', { name: 'Start sprint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be started');
    await user.selectOptions(
      section('Checkout Sprint 1').getByRole('combobox', { name: 'Move unfinished tickets to' }),
      'Checkout Sprint 2',
    );
    await user.click(section('Checkout Sprint 1').getByRole('button', { name: 'Complete sprint' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Checkout Sprint 1' })).toBeNull(),
    );
    expect(keysIn('Checkout Sprint 2')).toEqual(['CHK-3', 'CHK-1']);
    await user.click(section('Checkout Sprint 2').getByRole('button', { name: 'Start sprint' }));
    await waitFor(() => expect(client.state().sprints[0]?.state).toBe('active'));
    await user.click(screen.getByRole('button', { name: 'Create sprint' }));
    expect(await screen.findByRole('heading', { name: 'Checkout Sprint 3' })).toBeVisible();
  });

  it('[AGL-010] fits a phone: sections stack, nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderBacklog();
    await screen.findByRole('heading', { name: 'Checkout Sprint 1' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

describe('the sprint report (M1-044)', () => {
  it('[AGL-010] marks scope change and changed estimates, with the totals', async () => {
    render(
      <I18nProvider locale="en">
        <SprintReportPage boardId={7} sprintId={11} client={fakeSprintClient()} />
      </I18nProvider>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Sprint report: Checkout Sprint 1' }),
    ).toBeVisible();
    const open = section('Tickets not completed');
    expect(open.getByText('3h → 5h')).toBeVisible();
    expect(open.getByText('Added after the start')).toBeVisible();
    expect(section('Completed tickets').getByRole('link', { name: 'CHK-2' })).toBeVisible();
    expect(screen.getByText('Committed at the start').nextElementSibling).toHaveTextContent('5h');
  });
});

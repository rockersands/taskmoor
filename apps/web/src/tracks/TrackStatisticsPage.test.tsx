import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Board } from '../boards/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { fakeReportClient, REPORT_BOARD, SCRUM_REPORT_BOARD } from '../reports/fixtures';
import { fakeSprintClient } from '../sprints/fixtures';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeTrackClient } from './fixtures';
import { type TrackReport, TrackStatisticsPage } from './TrackStatisticsPage';

const inTrack = (board: Board): Board => ({
  ...board,
  location: { type: 'track', track: { id: 1, key: 'SHOP', name: 'Shop' } },
});
const KANBAN = inTrack(REPORT_BOARD);
const SCRUM = inTrack(SCRUM_REPORT_BOARD);

function open(
  report: TrackReport,
  board = KANBAN,
  { locale = 'en' as Locale, client = fakeTrackClient(), sprintId = null as number | null } = {},
) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <TrackStatisticsPage
        trackKey="SHOP"
        board={board}
        report={report}
        sprintId={sprintId}
        reports={fakeReportClient(board)}
        sprints={fakeSprintClient()}
        client={client}
      />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

describe('a track’s statistics (ADR-116)', () => {
  it('[RPT-001] [RPT-002] lists every report of the track, each link inside its tabs', async () => {
    open('cumulative-flow');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Statistics of Shop' }),
    ).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'Cumulative flow',
      'Control chart',
      'Cycle time',
      'Time in status',
      'Sprint report',
      'Velocity',
      'Release burndown',
      'Outcome burndown',
      'Release report',
      'Created vs closed',
      'Recently created',
      'Average age',
      'Time to close',
      'Ticket statistics',
      'Two-dimensional statistics',
    ]);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^#\/tracks\/SHOP\/statistics\/[a-z-]+$/);
    }
    expect(within(nav).getByRole('link', { name: 'Cumulative flow' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('figure', { name: 'Cumulative flow' })).toBeVisible();
  });

  it('[RPT-001] a report that follows sprints says so on a Kanban board instead of failing', async () => {
    for (const report of [
      'sprint-report',
      'velocity',
      'release-burndown',
      'outcome-burndown',
      'release-report',
    ] as const) {
      const { container } = open(report);
      expect(within(container).queryByRole('alert')).toBeNull();
      expect(within(container).getByText(/needs a Scrum board$/)).toBeVisible();
      container.remove();
    }
  });

  it('[RPT-001] offers those who may configure the board the way to change its kind', () => {
    const { container } = open('velocity', { ...KANBAN, mayConfigure: true });
    expect(
      within(container).getByRole('link', { name: "Change the board's kind" }),
    ).toHaveAttribute('href', `#/boards/${KANBAN.id}/settings`);
  });

  it('[RPT-001] a Scrum board’s sprint report starts on the running sprint and stays in the tabs', async () => {
    open('sprint-report', SCRUM);
    const picker = await screen.findByRole('combobox', { name: 'Sprint' });
    expect(picker).toHaveDisplayValue('Checkout Sprint 1');
    expect(await screen.findByRole('figure', { name: 'Burndown' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to the backlog' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/backlog',
    );
    // One level-one heading: the page's.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('[RPT-001] shows velocity alone', async () => {
    open('velocity', SCRUM);
    expect(await screen.findByRole('figure', { name: 'Velocity' })).toBeVisible();
    expect(screen.queryByRole('figure', { name: 'Burndown' })).toBeNull();
  });

  it('[RPT-002] created vs closed reads the track over the period chosen', async () => {
    const user = userEvent.setup();
    const { client } = open('created-vs-closed');
    expect(await screen.findByRole('figure', { name: 'Created vs closed' })).toBeVisible();
    expect(client.statisticCalls.at(-1)).toEqual({
      kind: 'created-vs-closed',
      settings: { days: 30, period: 'day', cumulative: false },
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'Last 90 days');
    await user.click(screen.getByRole('checkbox', { name: 'Running totals' }));
    await waitFor(() =>
      expect(client.statisticCalls.at(-1)?.settings).toEqual({
        days: 90,
        period: 'day',
        cumulative: true,
      }),
    );
  });

  it('[RPT-005] two-dimensional statistics take any two fields, custom ones included', async () => {
    const user = userEvent.setup();
    const { client } = open('two-dimensional');
    const table = await screen.findByRole('region', { name: 'Two-dimensional statistics' });
    expect(within(table).getByRole('rowheader', { name: 'New' })).toBeVisible();
    const across = screen.getByRole('combobox', { name: 'Columns' });
    await within(across).findByRole('option', { name: 'Team' });
    await user.selectOptions(across, 'Team');
    await waitFor(() =>
      expect(client.statisticCalls.at(-1)?.settings).toEqual({ x: 'status', y: 'cf[9]' }),
    );
  });

  it('[RPT-001] fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open('created-vs-closed');
    await screen.findByRole('figure', { name: 'Created vs closed' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-002] every text goes through the catalogue (en-XA)', async () => {
    const { container, errors } = open('velocity', KANBAN, { locale: 'en-XA' });
    await screen.findByRole('heading', { level: 1 });
    const texts = visibleTexts(container).filter((t) => t !== 'Shop');
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

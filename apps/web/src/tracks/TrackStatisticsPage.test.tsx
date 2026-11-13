import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

/** The statistics of the Scrum track with a report client the test may change and look into. */
function openWithReports(
  report: TrackReport,
  change: (client: ReturnType<typeof fakeReportClient>) => void = () => {},
) {
  const reportClient = fakeReportClient(SCRUM);
  change(reportClient);
  render(
    <I18nProvider locale="en">
      <TrackStatisticsPage
        trackKey="SHOP"
        board={SCRUM}
        report={report}
        reports={reportClient}
        sprints={fakeSprintClient()}
        client={fakeTrackClient()}
      />
    </I18nProvider>,
  );
  return { reportClient };
}

describe('a track’s statistics (ADR-116)', () => {
  it('[CORE-002] lists nothing that follows sprints on a Kanban track', async () => {
    open('cumulative-flow', KANBAN);
    await screen.findByRole('heading', { level: 1, name: 'Statistics' });
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Cumulative flow',
      'Control chart',
      'Cycle time',
      'Time in status',
      'Created vs closed',
      'Recently created',
      'Average age',
      'Time to close',
      'Tickets by date',
      'Pie chart',
      'Ticket statistics',
      'Two-dimensional statistics',
      'Grouped tickets',
      'Time tracking',
      'Workload by person',
      'Release workload',
      'Workload pie chart',
    ]);
    expect(within(nav).getByRole('group', { name: 'Time and workload' })).toBeVisible();
    expect(within(nav).queryByRole('group', { name: 'Sprints' })).toBeNull();
    expect(within(nav).queryByRole('group', { name: 'Releases' })).toBeNull();
  });

  it('[RPT-001] [RPT-002] lists every report of the track, each link inside its tabs', async () => {
    open('cumulative-flow', SCRUM);
    expect(await screen.findByRole('heading', { level: 1, name: 'Statistics' })).toBeVisible();
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
      'Outcome report',
      'Created vs closed',
      'Recently created',
      'Average age',
      'Time to close',
      'Tickets by date',
      'Pie chart',
      'Ticket statistics',
      'Two-dimensional statistics',
      'Grouped tickets',
      'Time tracking',
      'Workload by person',
      'Release workload',
      'Workload pie chart',
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
      'outcome-report',
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
    // The track's Backlog tab is right above: no pill repeats it (D7).
    expect(screen.queryByRole('link', { name: 'Back to the backlog' })).toBeNull();
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

  it('[RPT-002] [RPT-005] the reports by a field ask for the track’s custom fields by its id (T-251)', async () => {
    for (const report of [
      'group-by',
      'pie',
      'ticket-statistics',
      'two-dimensional',
      'workload-pie',
    ] as const) {
      const { client } = open(report);
      await waitFor(() => expect(client.groupFieldCalls, report).toEqual([1]));
      cleanup();
    }
  });

  it('[RPT-005] a report by a field still draws, with the system fields, when its custom fields cannot be read', async () => {
    const client = fakeTrackClient();
    client.groupFields = async () => {
      throw new Error('unavailable');
    };
    open('two-dimensional', KANBAN, { client });
    const table = await screen.findByRole('region', { name: 'Two-dimensional statistics' });
    expect(within(table).getByRole('rowheader', { name: 'New' })).toBeVisible();
    const across = screen.getByRole('combobox', { name: 'Columns' });
    expect(within(across).getByRole('option', { name: 'Priority' })).toBeInTheDocument();
    expect(within(across).queryByRole('option', { name: 'Team' })).toBeNull();
  });

  it('[RPT-002] tickets by date counts by the date chosen, with running totals', async () => {
    const user = userEvent.setup();
    const { client } = open('time-since');
    expect(await screen.findByRole('figure', { name: 'Tickets by date' })).toBeVisible();
    expect(client.statisticCalls.at(-1)).toEqual({
      kind: 'time-since',
      settings: { field: 'created', days: 30, period: 'day', cumulative: false },
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Date' }), 'Due');
    await user.click(screen.getByRole('checkbox', { name: 'Running totals' }));
    await waitFor(() =>
      expect(client.statisticCalls.at(-1)?.settings).toEqual({
        field: 'due',
        days: 30,
        period: 'day',
        cumulative: true,
      }),
    );
  });

  it('[RPT-002] a pie chart and grouped tickets group the track by the field chosen', async () => {
    const user = userEvent.setup();
    const pie = open('pie');
    expect(await screen.findByRole('figure', { name: 'Pie chart' })).toBeVisible();
    expect(pie.client.statisticCalls.at(-1)).toEqual({
      kind: 'pie',
      settings: { field: 'status' },
    });
    pie.container.remove();
    const grouped = open('group-by');
    const groups = await screen.findByRole('list', { name: 'Grouped tickets' });
    expect(within(groups).getByText('Ada Lovelace')).toBeVisible();
    expect(within(groups).getByText('1 of 3 done')).toBeVisible();
    expect(within(groups).getByRole('link', { name: 'SHOP-41' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-41',
    );
    // Two of three listed: the rest is a search away.
    expect(within(groups).getByText('2 tickets of 3')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field' }), 'Assignee');
    await waitFor(() =>
      expect(grouped.client.statisticCalls.at(-1)).toEqual({
        kind: 'group-by',
        settings: { field: 'assignee' },
      }),
    );
  });

  it('[RPT-002] time tracking adds up the track, or one release', async () => {
    const user = userEvent.setup();
    const { client } = open('time-tracking', SCRUM);
    expect(await screen.findByText('10h')).toBeVisible();
    expect(screen.getByText('1h under the estimate')).toBeVisible();
    expect(screen.getByText('4 of 6 tickets have an original estimate.')).toBeVisible();
    const rows = screen.getByRole('region', { name: 'Time tracking' });
    expect(within(rows).getByRole('link', { name: 'SHOP-41' })).toBeVisible();
    expect(client.statisticCalls.at(-1)).toEqual({ kind: 'time-tracking', settings: {} });
    const release = screen.getByRole('combobox', { name: 'Release' });
    expect(release).toHaveDisplayValue('The whole track');
    await user.selectOptions(release, 'Checkout 2.0');
    await waitFor(() =>
      expect(client.statisticCalls.at(-1)).toEqual({
        kind: 'time-tracking',
        settings: { release: 31 },
      }),
    );
  });

  it('[RPT-002] workload by person, of a release and as a pie read one report set three ways', async () => {
    const user = userEvent.setup();
    const person = open('user-workload');
    const table = await screen.findByRole('region', { name: 'Workload by person' });
    expect(within(table).getByRole('rowheader', { name: 'Ada Lovelace' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: '3h' })).toBeVisible();
    expect(person.client.statisticCalls.at(-1)).toEqual({
      kind: 'workload',
      settings: { field: 'assignee', statistic: 'remainingEstimate', open: true },
    });
    person.container.remove();

    const release = open('release-workload', SCRUM);
    await screen.findByRole('region', { name: 'Release workload' });
    expect(release.client.statisticCalls.at(-1)?.settings).toEqual({
      field: 'assignee',
      statistic: 'remainingEstimate',
      open: true,
      release: 31,
    });
    expect(screen.getByRole('combobox', { name: 'Release' })).toHaveDisplayValue('Checkout 2.0');
    release.container.remove();

    const pie = open('workload-pie');
    expect(await screen.findByRole('figure', { name: 'Workload pie chart' })).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure' }), 'Time spent');
    await user.click(screen.getByRole('checkbox', { name: 'Open tickets only' }));
    await waitFor(() =>
      expect(pie.client.statisticCalls.at(-1)?.settings).toEqual({
        field: 'assignee',
        statistic: 'timeSpent',
        open: false,
        view: 'pie',
      }),
    );
  });

  it('[RPT-002] a release’s workload explains a track with no releases', async () => {
    const reports = fakeReportClient(SCRUM);
    reports.releases = async () => [];
    render(
      <I18nProvider locale="en">
        <TrackStatisticsPage
          trackKey="SHOP"
          board={SCRUM}
          report="release-workload"
          reports={reports}
          sprints={fakeSprintClient()}
          client={fakeTrackClient()}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText('No releases yet')).toBeVisible();
  });

  it('[RPT-001] the outcome report lists the outcome’s tickets, done and open', async () => {
    open('outcome-report', SCRUM);
    expect(await screen.findByRole('figure', { name: 'Release progress' })).toBeVisible();
    const tickets = screen.getByRole('region', { name: 'Tickets under the outcome' });
    expect(within(tickets).getAllByRole('cell', { name: 'Closed (done)' })).toHaveLength(2);
    expect(within(tickets).getByRole('cell', { name: 'No estimate' })).toBeVisible();
    expect(screen.getByText('Open without an estimate')).toBeVisible();
  });

  it('[RPT-001] picks an outcome from the track’s outcomes, the first chosen, instead of a typed key (D25)', async () => {
    const user = userEvent.setup();
    const { reportClient } = openWithReports('outcome-burndown');
    const picker = await screen.findByRole('combobox', { name: 'Outcome' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'SHOP-50 Card payments in every market',
      'SHOP-51 A faster checkout',
      'SHOP-52 Gift cards',
      'SHOP-47 Saved addresses',
    ]);
    expect(screen.queryByRole('textbox', { name: 'Outcome' })).toBeNull();
    await waitFor(() =>
      expect(reportClient.calls.at(-1)).toEqual({
        report: 'outcome-burndown',
        params: { outcome: 'SHOP-50' },
      }),
    );
    await user.selectOptions(picker, 'SHOP-52');
    expect(await screen.findByRole('link', { name: 'SHOP-52' })).toBeVisible();
  });

  it('[RPT-001] explains a release burndown with no estimates instead of charting zeros (TR-13)', async () => {
    openWithReports('release-burndown', (client) => {
      const read = client.releaseBurndown;
      client.releaseBurndown = async (board, release) => {
        const report = await read(board, release);
        const zero = { start: 0, completed: 0, added: 0, removed: 0, end: 0 };
        return {
          ...report,
          statistic: { statistic: 'field', fieldId: 31 },
          sprints: report.sprints.map((s) => ({ ...s, ...zero })),
          now: { scope: 0, completed: 0, remaining: 0 },
        };
      };
    });
    expect(await screen.findByText('No estimates to add up')).toBeVisible();
    expect(screen.queryByRole('figure', { name: 'Remaining work' })).toBeNull();
  });

  it('[RPT-001] says a shipped release shipped on its own day, with no forecast (TR-15)', async () => {
    const { reportClient } = openWithReports('release-report', (client) => {
      const read = client.releaseReport;
      client.releaseReport = async (board, release) => {
        const report = await read(board, release);
        return {
          ...report,
          release: {
            ...report.release,
            releaseDate: '2026-08-18',
            shippedAt: '2026-11-05T21:00:00Z',
          },
        };
      };
    });
    expect(await screen.findByText('Shipped on Aug 18.')).toBeVisible();
    expect(screen.queryByText(/At the pace of the last/)).toBeNull();
  });

  it('[RPT-001] offers one Report picker on a phone instead of the grouped links (D5, TR-5)', async () => {
    const user = userEvent.setup();
    setViewportWidth(375);
    open('velocity', SCRUM);
    const picker = await screen.findByRole('combobox', { name: 'Report' });
    expect(picker).toHaveValue('velocity');
    expect(screen.queryByRole('navigation', { name: 'Reports' })).toBeNull();
    expect(
      within(picker)
        .getAllByRole('group')
        .map((g) => g.getAttribute('label')),
    ).toEqual(['Flow', 'Sprints', 'Releases', 'Tickets', 'Time and workload']);
    await user.selectOptions(picker, 'Release burndown');
    expect(window.location.hash).toBe('#/tracks/SHOP/statistics/release-burndown');
  });

  it('[RPT-001] keeps the grouped links on a wide screen, each group named by its label (TR-6)', async () => {
    open('velocity', SCRUM);
    const nav = await screen.findByRole('navigation', { name: 'Reports' });
    expect(screen.queryByRole('combobox', { name: 'Report' })).toBeNull();
    const sprints = within(nav).getByRole('group', { name: 'Sprints' });
    expect(within(sprints).getByRole('link', { name: 'Velocity' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(sprints.querySelector('.statistics-tab-links')).toContainElement(
      within(sprints).getByRole('link', { name: 'Sprint report' }),
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

  it('[RPT-002] the new reports put every text through the catalogue too (en-XA)', async () => {
    // Names, keys and summaries come from the data, not the catalogue.
    const data = /^(SHOP-\d+|Shop|Team|Ada Lovelace|Grace Hopper|Checkout 2\.0|Active|Closed)$/;
    for (const report of [
      'time-since',
      'group-by',
      'time-tracking',
      'user-workload',
      'workload-pie',
    ] as const) {
      const { container, errors } = open(report, SCRUM, { locale: 'en-XA' });
      await waitFor(() => expect(container.querySelector('.report-loading')).toBeNull());
      const texts = visibleTexts(container).filter(
        (t) =>
          !data.test(t) &&
          !/^[\d.,\s:%h]+$/.test(t) &&
          // Dates come formatted by the browser, not the catalogue.
          !/^[A-Z][a-z]{2} \d{1,2}$/.test(t) &&
          !/[Cc]ard|[Cc]heckout|Gift/.test(t),
      );
      expect(untranslated(texts), report).toEqual([]);
      expect(errors, report).toEqual([]);
      container.remove();
    }
  });
});

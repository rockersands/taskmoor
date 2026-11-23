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
import { fakeTrackClient, TWO_DIMENSIONAL } from './fixtures';
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

  it('[CORE-002] a Kanban track’s purpose names only the reports it lists (S3-ST-3)', async () => {
    open('cumulative-flow', KANBAN);
    expect(
      await screen.findByText(
        'Every report of this track in one place: how its work flows, its tickets and the time spent on them.',
      ),
    ).toBeVisible();
    cleanup();
    open('cumulative-flow', SCRUM);
    expect(
      await screen.findByText(
        'Every report of this track in one place: how its work flows, its sprints, its releases and its tickets.',
      ),
    ).toBeVisible();
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
      within(container).getByRole('link', { name: 'Change the board’s kind' }),
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

  it('[RPT-002] a long group links to the search that finds all of it, named after its group (S3-ST-2, T-359)', async () => {
    open('group-by');
    const groups = await screen.findByRole('list', { name: 'Grouped tickets' });
    // Its name starts with the words it shows, then says which group (WCAG 2.5.3).
    const all = within(groups).getByRole('link', {
      name: 'See all 3 in Search: Ada Lovelace',
    });
    expect(all).toHaveTextContent(/^See all 3 in Search$/);
    // The server's search, which lists the group as the report does (most recently updated first).
    expect(new URLSearchParams(all.getAttribute('href')?.split('?')[1]).get('q')).toBe(
      'track = "SHOP" AND assignee = 2 ORDER BY updated DESC',
    );
    // The group with every ticket listed needs no way to the rest.
    expect(within(groups).getAllByRole('link', { name: /^See all/ })).toHaveLength(1);
  });

  it('[RPT-002] time tracking with nothing estimated gives no verdict on the estimate (S3-ST-1)', async () => {
    const client = fakeTrackClient();
    const zero = { release: null, tickets: 53, estimated: 0, original: 0, remaining: 0, spent: 0 };
    client.statistics = async () => ({ ...zero, rows: [] });
    open('time-tracking', SCRUM, { client });
    expect(await screen.findByText('Nothing estimated or logged yet')).toBeVisible();
    expect(screen.queryByText('On the estimate')).toBeNull();
    cleanup();
    // Time logged, but no original estimate: the totals show, the verdict says why it has none.
    const logged = fakeTrackClient();
    logged.statistics = async () => ({ ...zero, spent: 3600, rows: [] });
    open('time-tracking', SCRUM, { client: logged });
    expect(await screen.findByText('Nothing estimated to compare')).toBeVisible();
    expect(screen.queryByText('On the estimate')).toBeNull();
    expect(screen.queryByText(/over the estimate/)).toBeNull();
  });

  it('[RPT-002] time tracking with nothing estimated, in Spanish (S3-ST-1)', async () => {
    const client = fakeTrackClient();
    client.statistics = async () => ({
      release: null,
      tickets: 2,
      estimated: 0,
      original: 0,
      remaining: 0,
      spent: 0,
      rows: [],
    });
    open('time-tracking', SCRUM, { client, locale: 'es' });
    expect(await screen.findByText('Aún no hay nada estimado ni registrado')).toBeVisible();
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

  it('[RPT-002] a release’s workload starts on a release still to ship, else the one that shipped last, and says why one has no open tickets (S3-ST-9, T-359)', async () => {
    const reports = fakeReportClient(SCRUM);
    reports.releases = async () => [
      { id: 30, name: 'Checkout 1.0', shipped: true, archived: false },
      { id: 31, name: 'Checkout 2.0', shipped: false, archived: false },
    ];
    const client = fakeTrackClient();
    const read = client.statistics;
    client.statistics = async (key, kind, settings) => {
      const data = await read(key, kind, settings);
      // The shipped release: every one of its tickets is closed.
      return (settings as { release?: number }).release === 30
        ? { ...(data as object), values: [], total: 0, seconds: 0, unestimated: 0 }
        : data;
    };
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <TrackStatisticsPage
          trackKey="SHOP"
          board={SCRUM}
          report="release-workload"
          reports={reports}
          sprints={fakeSprintClient()}
          client={client}
        />
      </I18nProvider>,
    );
    const release = await screen.findByRole('combobox', { name: 'Release' });
    await waitFor(() => expect(release).toHaveDisplayValue('Checkout 2.0'));
    await user.selectOptions(release, 'Checkout 1.0');
    expect(await screen.findByText('No open tickets target this release')).toBeVisible();
    expect(screen.queryByText('No tickets.')).toBeNull();
    cleanup();
    // Every release shipped: the one that shipped last, as the release reports open (T-359).
    reports.releases = async () => [
      { id: 30, name: 'Checkout 1.0', shipped: true, shippedAt: '2026-10-02T10:00:00Z' },
      { id: 31, name: 'Checkout 2.0', shipped: true, shippedAt: '2026-08-18T10:00:00Z' },
    ];
    render(
      <I18nProvider locale="en">
        <TrackStatisticsPage
          trackKey="SHOP"
          board={SCRUM}
          report="release-workload"
          reports={reports}
          sprints={fakeSprintClient()}
          client={client}
        />
      </I18nProvider>,
    );
    const last = await screen.findByRole('combobox', { name: 'Release' });
    await waitFor(() => expect(last).toHaveDisplayValue('Checkout 1.0'));
  });

  it('[RPT-002] a workload pie with no time names the measure in the sentence’s own words', async () => {
    const client = fakeTrackClient();
    const read = client.statistics;
    client.statistics = async (key, kind, settings) => {
      const data = (await read(key, kind, settings)) as { values: { seconds: number }[] };
      // The measure asked for, with no ticket having any of it.
      const { statistic } = settings as { statistic: string };
      return {
        ...data,
        statistic,
        values: data.values.map((v) => ({ ...v, seconds: 0 })),
        seconds: 0,
      };
    };
    const user = userEvent.setup();
    open('workload-pie', KANBAN, { client });
    expect(await screen.findByText('No ticket here has a remaining estimate.')).toBeVisible();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Measure' }),
      'Original estimate',
    );
    expect(await screen.findByText('No ticket here has an original estimate.')).toBeVisible();
    cleanup();
    open('workload-pie', KANBAN, { client, locale: 'es' });
    expect(
      await screen.findByText('Ningún ticket de aquí tiene estimación restante.'),
    ).toBeVisible();
  });

  it('[RPT-005] two-dimensional statistics head the row names with their field (S3-ST-8)', async () => {
    open('two-dimensional');
    const table = await screen.findByRole('region', { name: 'Two-dimensional statistics' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Status', 'High', 'None', 'Total']);
    cleanup();
    // A custom field's rows are headed with its own name, as the server gives it.
    const client = fakeTrackClient();
    client.statistics = async () => ({
      ...TWO_DIMENSIONAL,
      fields: { x: 'cf[9]', y: 'priority' },
      fieldNames: { x: 'Team', y: null },
    });
    open('two-dimensional', KANBAN, { client });
    const custom = await screen.findByRole('region', { name: 'Two-dimensional statistics' });
    expect(within(custom).getAllByRole('columnheader')[0]).toHaveTextContent('Team');
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
    // Its own title, and the measure the lines add up named, since the tiles count tickets.
    const chart = await screen.findByRole('figure', { name: 'Outcome progress' });
    expect(screen.queryByRole('figure', { name: 'Release progress' })).toBeNull();
    expect(within(chart).getByText('Estimate')).toBeVisible();
    expect(within(chart).getByRole('list').textContent).toBe('Estimate in scopeEstimate completed');
    const tickets = screen.getByRole('region', { name: 'Tickets under the outcome' });
    expect(within(tickets).getAllByRole('cell', { name: 'Closed (done)' })).toHaveLength(2);
    expect(within(tickets).getByRole('cell', { name: 'No estimate' })).toBeVisible();
    for (const tile of ['Tickets done', 'Tickets still open', 'Open tickets without an estimate']) {
      expect(screen.getByText(tile)).toBeVisible();
    }
  });

  // The outcome report's forecast reads its day with the year, as the release report's same
  // sentence does, in the person's locale (T-240).
  it('[RPT-001] [NFR-006] the outcome report’s forecast reads its day as the release report’s does, in English', async () => {
    open('outcome-report', SCRUM);
    expect(
      await screen.findByText('At the pace of the last 14 days, the work is done by Nov 12, 2026.'),
    ).toBeVisible();
  });

  it('[RPT-001] [NFR-006] the outcome report’s forecast reads its day as the release report’s does, in Spanish', async () => {
    open('outcome-report', SCRUM, { locale: 'es' });
    expect(
      await screen.findByText(
        'Al ritmo de los últimos 14 días, el trabajo estará hecho el 12 nov 2026.',
      ),
    ).toBeVisible();
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

  it('[RPT-001] an estimate total of 0 explains itself even when estimates came and went (TR-13)', async () => {
    openWithReports('outcome-burndown', (client) => {
      const read = client.outcomeBurndown;
      client.outcomeBurndown = async (board, outcome) => {
        const report = await read(board, outcome);
        // Every estimate was later taken off: nothing is left to add up.
        return {
          ...report,
          statistic: { statistic: 'field', fieldId: 31 },
          sprints: report.sprints.map((s) => ({ ...s, start: 3, removed: 3, end: 0 })),
          outside: { completed: 0, added: 3, removed: 0 },
          now: { scope: 0, completed: 0, remaining: 0 },
        };
      };
    });
    expect(await screen.findByText('No estimates to add up')).toBeVisible();
    expect(screen.queryByRole('figure', { name: 'Work per sprint' })).toBeNull();
  });

  it('[RPT-001] work done before the sprints is counted beside them, as the sentence says (TR-13)', async () => {
    openWithReports('release-burndown', (client) => {
      const read = client.releaseBurndown;
      client.releaseBurndown = async (board, release) => {
        const report = await read(board, release);
        const zero = { start: 0, completed: 0, added: 0, removed: 0, end: 0 };
        // The sweep's release 5.0: both points done before its first sprint.
        return {
          ...report,
          sprints: report.sprints.map((s) => ({ ...s, ...zero })),
          outside: { completed: 2, added: 2, removed: 0 },
          now: { scope: 2, completed: 2, remaining: 0 },
          forecast: 0,
        };
      };
    });
    expect(await screen.findByText(/0 remaining of 2; 2 done\./)).toBeVisible();
    const perSprint = screen.getByRole('figure', { name: 'Work per sprint' });
    // Its column label may wrap onto two lines.
    expect(perSprint.querySelector('svg')?.textContent).toMatch(/Outside the\s*sprints/);
    const table = screen.getByRole('region', { name: 'Work by sprint' });
    expect(within(table).getAllByRole('row').at(-1)?.textContent).toBe('Outside the sprints220');
  });

  it('[RPT-001] says a shipped release shipped on its own day, with no forecast (TR-15)', async () => {
    openWithReports('release-report', (client) => {
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
    // With its year, as the release's page and the Releases list say it (T-240).
    expect(await screen.findByText('Shipped on Aug 18, 2026.')).toBeVisible();
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

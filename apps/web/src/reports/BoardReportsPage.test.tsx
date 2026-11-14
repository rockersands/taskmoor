import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type BoardReport, BoardReportsPage } from './BoardReportsPage';
import {
  fakeReportClient,
  RELEASES,
  REPORT_BOARD,
  SCRUM_REPORT_BOARD,
  SUMMARIES,
} from './fixtures';

function open(report: BoardReport, locale: Locale = 'en', client = fakeReportClient()) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <BoardReportsPage boardId={7} report={report} client={client} />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}
const cells = (row: HTMLElement) => [...row.querySelectorAll('th, td')].map((c) => c.textContent);

describe('board reports (M1-061)', () => {
  it('[RPT-001] shows cumulative flow by column, in board order, and what no column shows', async () => {
    const { client } = open('cumulative-flow');
    const figure = await screen.findByRole('figure', { name: 'Cumulative flow' });
    expect(within(figure).getByRole('list').textContent).toBe('To doDoingBlockedReviewDone');
    const rows = within(figure).getAllByRole('row');
    expect(rows).toHaveLength(29);
    expect(cells(rows[0] as HTMLElement)).toEqual([
      'Day',
      'To do',
      'Doing',
      'Blocked',
      'Review',
      'Done',
    ]);
    expect(cells(rows[1] as HTMLElement)).toEqual(['Oct 2', '9', '5', '2', '2', '4']);
    expect(within(figure).getByRole('img').getAttribute('aria-label')).toBe(
      'Cumulative flow over 28 days: 63 tickets on the board on the last day, 47 of them in Done.',
    );
    expect(
      screen.getByText('1 ticket is in a status no column shows and is not counted.'),
    ).toBeVisible();
    expect(screen.getByText('From Oct 2 to Oct 29')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Cumulative flow' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(client.calls).toEqual([
      { report: 'cumulative-flow', params: { days: 30, filters: [] } },
    ]);
  });

  it('[RPT-001] the period and the board filters narrow every report', async () => {
    const user = userEvent.setup();
    const { client } = open('time-in-status');
    await screen.findByRole('figure', { name: 'Average time in status' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'Last 90 days');
    await waitFor(() => expect(client.calls.at(-1)?.params).toEqual({ days: 90, filters: [] }));
    await user.click(screen.getByRole('checkbox', { name: 'My work' }));
    await waitFor(() =>
      expect(client.calls.at(-1)?.params).toEqual({ days: 90, filters: ['mine'] }),
    );
    // Choosing dates starts from the window shown.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'Choose dates');
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-02');
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-29');
    await waitFor(() =>
      expect(client.calls.at(-1)?.params).toEqual({
        from: '2026-10-02',
        to: '2026-10-29',
        filters: ['mine'],
      }),
    );
  });

  it('[RPT-001] the control chart counts the chosen columns and averages two ways', async () => {
    const user = userEvent.setup();
    const { client } = open('control-chart');
    const figure = await screen.findByRole('figure', { name: 'Control chart' });
    expect(within(figure).getByRole('list').textContent).toBe(
      'TicketRolling averageStandard deviation',
    );
    // A row per ticket, with its link.
    expect(within(figure).getAllByRole('row')).toHaveLength(37);
    expect(within(figure).getByRole('link', { name: 'SHOP-100' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-100',
    );
    const stats = screen.getByText('Median').closest('dl') as HTMLElement;
    expect([...stats.querySelectorAll('div')].map((d) => d.textContent)).toEqual([
      'Tickets36',
      'Average2.3d',
      'Median2.3d',
      '85th percentile3.2d',
      '95th percentile4.3d',
    ]);
    expect(screen.getByRole('checkbox', { name: 'To do' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Doing' })).toBeChecked();
    // Leaving the blocked column out of the work.
    await user.click(screen.getByRole('checkbox', { name: 'Blocked' }));
    await waitFor(() =>
      expect(client.calls.at(-1)?.params).toMatchObject({ columns: ['doing', 'review'] }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Review' }));
    // The last chosen column stays.
    expect(screen.getByRole('checkbox', { name: 'Doing' })).toBeDisabled();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Rolling average' }),
      'Over days',
    );
    await user.type(screen.getByRole('spinbutton', { name: 'Days in the average' }), '5');
    await waitFor(() =>
      expect(client.calls.at(-1)?.params).toEqual({
        days: 30,
        filters: [],
        columns: ['doing'],
        average: 'days',
        window: 5,
      }),
    );
  });

  it('[RPT-001] the cycle time report shows the distribution in steps', async () => {
    open('cycle-time');
    const figure = await screen.findByRole('figure', { name: 'Cycle time distribution' });
    const rows = within(figure).getAllByRole('row');
    expect(cells(rows[1] as HTMLElement)).toEqual(['0h to 8h', '0']);
    expect(rows.slice(1).reduce((n, r) => n + Number(cells(r)[1]), 0)).toBe(36);
    expect(within(figure).getByRole('img').getAttribute('aria-label')).toBe(
      'Cycle times of 36 tickets in steps of 8h; 85% took 76h or less.',
    );
  });

  it('[RPT-001] time in status lists every status with its column', async () => {
    open('time-in-status');
    const table = (await screen.findAllByRole('table')).at(-1) as HTMLElement;
    expect(
      within(table)
        .getAllByRole('row')
        .map((r) => cells(r)),
    ).toEqual([
      ['Status', 'Column', 'Tickets', 'Average time', 'Total time', 'Times entered'],
      ['New', 'To do', '31', '2.9d', '90.4d', '22'],
      ['Active', 'Doing', '27', '1.3d', '33.8d', '34'],
      ['Blocked', 'Blocked', '6', '0.8d', '4.8d', '7'],
      ['In Review', 'Review', '22', '0.5d', '10.1d', '25'],
      ['Closed', 'Done', '48', '10.8d', '520d', '40'],
      ['Parked', 'Not on the board', '2', '3.8d', '7.5d', '1'],
    ]);
  });

  it('[RPT-001] time in status has one way to its numbers: the table, scrolled by keyboard with a cue (TR-12, TR-32)', async () => {
    const restore = (['scrollWidth', 'clientWidth'] as const).map((name) => {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get(this: HTMLElement) {
          if (!this.classList.contains('report-table')) return 0;
          return name === 'scrollWidth' ? 620 : 343;
        },
      });
      return () => delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    });
    try {
      open('time-in-status');
      const region = await screen.findByRole('region', { name: 'Time in each status' });
      expect(screen.queryByText('Show the numbers')).toBeNull();
      expect(region).toHaveAttribute('tabindex', '0');
      await waitFor(() => expect(region).toHaveAttribute('data-more', 'end'));
    } finally {
      for (const undo of restore) undo();
    }
  });

  it('[RPT-001] says when a report cannot be loaded or has nothing to show', async () => {
    const failing = fakeReportClient();
    failing.cumulativeFlow = async () => {
      throw new Error('network');
    };
    open('cumulative-flow', 'en', failing);
    expect(await screen.findByRole('alert')).toHaveTextContent('The report could not be loaded.');
    const empty = fakeReportClient();
    const base = await empty.cycleTime(7, {});
    empty.cycleTime = async () => ({ ...base, total: 0, points: [] });
    open('control-chart', 'en', empty);
    expect(
      await screen.findByText('No ticket moved past the chosen columns in this period.'),
    ).toBeVisible();
  });

  it('[RPT-001] fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open('control-chart');
    await screen.findByRole('figure', { name: 'Control chart' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-001] every text goes through the catalogue (en-XA)', async () => {
    for (const report of ['cumulative-flow', 'control-chart', 'time-in-status'] as const) {
      const { container, errors } = open(report, 'en-XA');
      await screen.findAllByRole('figure');
      // Board, column, filter, status and ticket names are data, and so are dates and numbers.
      const data = new Set([
        REPORT_BOARD.name,
        ...REPORT_BOARD.columns.map((c) => c.name),
        ...REPORT_BOARD.boardFilters.map((f) => f.name),
        'New',
        'Active',
        'In Review',
        'Closed',
        'Parked',
        ...SUMMARIES,
      ]);
      const texts = visibleTexts(container).filter((t) => !/\d/.test(t) && !data.has(t));
      expect(untranslated(texts)).toEqual([]);
      expect(errors).toEqual([]);
      container.remove();
    }
  });
});

describe('release and outcome reports of a Scrum board (M1-062)', () => {
  const scrum = () => fakeReportClient(SCRUM_REPORT_BOARD);

  it('[RPT-001] only a Scrum board offers them', async () => {
    open('cumulative-flow');
    await screen.findByRole('figure', { name: 'Cumulative flow' });
    expect(screen.queryByRole('link', { name: 'Release burndown' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Reports' });
    expect(within(nav).getAllByRole('link')).toHaveLength(4);
  });

  it('[RPT-001] the release burndown shows the work at each sprint and a forecast', async () => {
    const user = userEvent.setup();
    const { client } = open('release-burndown', 'en', scrum());
    const remaining = await screen.findByRole('figure', { name: 'Remaining work' });
    expect(
      screen.getByText('24 remaining of 64; 40 done. At 11 a sprint, about 3 more sprints.'),
    ).toBeVisible();
    expect(
      within(remaining)
        .getAllByRole('row')
        .map((r) => cells(r)),
    ).toEqual([
      ['When', 'Remaining work'],
      ['Checkout Sprint 8', '40'],
      ['Checkout Sprint 9', '33'],
      ['Checkout Sprint 10', '30'],
      ['Now', '24'],
    ]);
    const perSprint = screen.getByRole('figure', { name: 'Work per sprint' });
    expect(within(perSprint).getByRole('list').textContent).toBe('CompletedAdded');
    const table = screen.getAllByRole('table').at(-1) as HTMLElement;
    expect(cells(within(table).getAllByRole('row')[2] as HTMLElement)).toEqual([
      'Checkout Sprint 9',
      '33',
      '10',
      '8',
      '3',
      '28',
    ]);
    // What was done and added while no sprint ran has its own column, so the columns add up to
    // the sentence: 12 + 10 + 6 + 12 = 40 done (TR-13).
    expect(cells(within(table).getAllByRole('row').at(-1) as HTMLElement)).toEqual([
      'Outside the sprints',
      '',
      '12',
      '54',
      '0',
      '',
    ]);
    expect(client.calls.at(-1)).toEqual({ report: 'release-burndown', params: { release: 31 } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Release' }), 'Checkout 2.1');
    await waitFor(() =>
      expect(client.calls.at(-1)).toEqual({ report: 'release-burndown', params: { release: 32 } }),
    );
  });

  it('[RPT-001] the outcome burndown follows the outcome whose key is given', async () => {
    const user = userEvent.setup();
    open('outcome-burndown', 'en', scrum());
    expect(await screen.findByText('Enter an outcome’s key to see its burndown.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Outcome' }), 'SHOP-7');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByRole('link', { name: 'SHOP-7' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-7',
    );
    expect(screen.getByText('One-page checkout')).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: 'Outcome' }));
    await user.type(screen.getByRole('textbox', { name: 'Outcome' }), 'SHOP-404{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No outcome with that key is visible to you.',
    );
  });

  it('[RPT-001] the release report shows progress by day, the plan and a forecast', async () => {
    open('release-report', 'en', scrum());
    const figure = await screen.findByRole('figure', { name: 'Release progress' });
    // The lines name what they add up; Completed is drawn last, over Scope, so it stays seen
    // once it reaches the scope.
    expect(within(figure).getByRole('list').textContent).toBe(
      'Estimate in scopeEstimate completed',
    );
    expect(within(figure).getByText('Estimate')).toBeVisible();
    const lines = [...figure.querySelectorAll('path.chart-line')];
    expect(lines.map((l) => l.getAttribute('class'))).toEqual([
      'chart-line chart-line-two',
      'chart-line chart-line-one',
    ]);
    expect(
      screen.getByText(
        'Planned for Nov 30. At the pace of the last 14 days, the work is done by Nov 11.',
      ),
    ).toBeVisible();
    expect(within(figure).getAllByRole('row')).toHaveLength(23);
  });

  it('[RPT-001] says when the board’s track has no releases', async () => {
    const client = scrum();
    client.releases = async () => [];
    open('release-report', 'en', client);
    expect(await screen.findByText('The board’s track has no releases.')).toBeVisible();
  });

  it('[RPT-001] every text goes through the catalogue (en-XA)', async () => {
    for (const report of ['release-burndown', 'release-report'] as const) {
      const { container, errors } = open(report, 'en-XA', scrum());
      await screen.findAllByRole('figure');
      const data = new Set([
        SCRUM_REPORT_BOARD.name,
        ...RELEASES.map((r) => r.name),
        'Checkout Sprint',
      ]);
      // A column label wrapped onto two lines shows as two pieces: put them back together.
      const texts = visibleTexts(container)
        .filter((t) => !/\d/.test(t) && !data.has(t))
        .reduce<string[]>((out, t) => {
          const last = out.at(-1);
          if (last?.startsWith('[') && !last.endsWith(']')) out[out.length - 1] = `${last} ${t}`;
          else out.push(t);
          return out;
        }, []);
      expect(untranslated(texts)).toEqual([]);
      expect(errors).toEqual([]);
      container.remove();
    }
  });
});

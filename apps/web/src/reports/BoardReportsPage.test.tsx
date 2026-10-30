import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type BoardReport, BoardReportsPage } from './BoardReportsPage';
import { fakeReportClient, REPORT_BOARD, SUMMARIES } from './fixtures';

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
    await user.click(screen.getByRole('checkbox', { name: 'Only my tickets' }));
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

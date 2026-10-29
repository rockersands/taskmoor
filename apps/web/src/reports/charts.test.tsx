import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ColumnChart } from './ColumnChart';
import { niceTicks } from './chart';
import { LineChart } from './LineChart';

const hours = (v: number) => `${v / 3600}h`;

describe('charts (M1-060)', () => {
  it('[RPT-001] picks round ticks, in hours when seconds show as hours', () => {
    expect(niceTicks(16)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(9 * 3600, 4, 3600)).toEqual([0, 2.5, 5, 7.5, 10].map((h) => h * 3600));
  });

  it('[RPT-001] a line chart names itself, has a legend for two series and its numbers as a table', () => {
    render(
      <LineChart
        title="Burndown"
        summary="Burndown: 8h at the start, 3h remaining now."
        xLabels={['Oct 26', 'Oct 27', 'Oct 28']}
        series={[
          { id: 'r', label: 'Remaining', tone: 'one', values: [8 * 3600, 6 * 3600, null] },
          { id: 'g', label: 'Guideline', tone: 'guide', values: [8 * 3600, 4 * 3600, 0] },
        ]}
        format={hours}
        unit={3600}
        tableLabel="Show the numbers"
        xHeader="Day"
      />,
    );
    const figure = screen.getByRole('figure', { name: 'Burndown' });
    expect(
      within(figure).getByRole('img', { name: 'Burndown: 8h at the start, 3h remaining now.' }),
    ).toBeInTheDocument();
    expect(within(figure).getByRole('list').textContent).toBe('RemainingGuideline');
    const rows = within(figure)
      .getAllByRole('row')
      .map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['Day', 'Remaining', 'Guideline'],
      ['Oct 26', '8h', '8h'],
      ['Oct 27', '6h', '4h'],
      ['Oct 28', '', '0h'],
    ]);
    // The last value of the data series is written at its end; the guideline is not labelled.
    expect(figure.querySelectorAll('.chart-value')).toHaveLength(1);
    expect(figure.querySelector('.chart-value')?.textContent).toBe('6h');
  });

  it('[RPT-001] shows the day under the pointer with every series value', () => {
    render(
      <LineChart
        title="Burnup"
        summary="Burnup"
        xLabels={['Oct 26', 'Oct 27']}
        series={[
          { id: 'c', label: 'Completed', tone: 'one', values: [0, 2] },
          { id: 's', label: 'Scope', tone: 'two', values: [8, 9] },
        ]}
        format={String}
        tableLabel="Show the numbers"
        xHeader="Day"
      />,
    );
    const plot = document.querySelector('.chart-plot') as HTMLElement;
    fireEvent.pointerMove(plot, { clientX: 2000 });
    const tip = document.querySelector('.chart-tooltip') as HTMLElement;
    expect(tip.textContent).toBe('Oct 27Completed 2Scope 9');
    fireEvent.pointerLeave(plot);
    expect(document.querySelector('.chart-tooltip')).toBeNull();
  });

  it('[RPT-001] a column chart has a legend, values at the tips and a table', () => {
    render(
      <ColumnChart
        title="Velocity"
        summary="Velocity of the last 2 sprints"
        categories={[
          { key: '8', label: 'Sprint 8' },
          { key: '9', label: 'Sprint 9' },
        ]}
        series={[
          { id: 'committed', label: 'Committed', tone: 'two', values: [12, 10] },
          { id: 'completed', label: 'Completed', tone: 'one', values: [10, 10] },
        ]}
        format={String}
        tableLabel="Show the numbers"
        categoryHeader="Sprint"
      />,
    );
    const figure = screen.getByRole('figure', { name: 'Velocity' });
    expect(within(figure).getByRole('list').textContent).toBe('CommittedCompleted');
    expect([...figure.querySelectorAll('.chart-value')].map((v) => v.textContent)).toEqual([
      '12',
      '10',
      '10',
      '10',
    ]);
    expect(
      within(figure)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual(['Sprint 81210', 'Sprint 91010']);
  });
});

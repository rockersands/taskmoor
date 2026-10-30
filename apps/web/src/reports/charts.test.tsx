import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ColumnChart } from './ColumnChart';
import { niceTicks } from './chart';
import { LineChart } from './LineChart';
import { ScatterChart } from './ScatterChart';
import { StackedAreaChart, stageFill } from './StackedAreaChart';

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
  it('[RPT-001] stacks ordered stages with the last at the bottom, on one ramp', () => {
    render(
      <StackedAreaChart
        title="Flow"
        summary="Flow"
        xLabels={['Oct 1', 'Oct 2']}
        layers={[
          { id: 'todo', label: 'To do', values: [3, 1] },
          { id: 'doing', label: 'Doing', values: [1, 2] },
          { id: 'done', label: 'Done', values: [0, 4] },
        ]}
        format={String}
        tableLabel="Show the numbers"
        xHeader="Day"
      />,
    );
    const figure = screen.getByRole('figure', { name: 'Flow' });
    expect(within(figure).getByRole('list').textContent).toBe('To doDoingDone');
    // Drawn from the bottom: done, doing, to do; the top of the stack is the total.
    expect(figure.querySelectorAll('.chart-area')).toHaveLength(3);
    expect(stageFill(0, 3)).toEqual({
      fill: 'color-mix(in oklab, var(--color-flow-first) 100%, var(--color-flow-last))',
    });
    expect(stageFill(1, 3).fill).toContain('var(--color-flow-first) 50%');
    expect(stageFill(2, 3).fill).toContain('var(--color-flow-first) 0%');
    expect(stageFill(0, 1)).toEqual({ fill: 'var(--color-flow-last)' });
    const plot = figure.querySelector('.chart-plot') as HTMLElement;
    fireEvent.pointerMove(plot, { clientX: 2000 });
    expect(figure.querySelector('.chart-tooltip')?.textContent).toBe('Oct 2To do 1Doing 2Done 4');
  });

  it('[RPT-001] a scatter shows the nearest dot under the pointer and lists every point', () => {
    render(
      <ScatterChart
        title="Control chart"
        summary="Control chart"
        points={[
          { id: '1', x: 0, y: 10, average: 10, deviation: 0, label: 'SHOP-1', detail: 'Refunds' },
          {
            id: '2',
            x: 1000,
            y: 4,
            average: 7,
            deviation: 3,
            label: 'SHOP-2',
            detail: 'Receipts',
            href: '#/tickets/SHOP-2',
          },
        ]}
        from={0}
        to={1000}
        formatX={(ms) => `t${ms}`}
        formatY={String}
        labels={{
          points: 'Ticket',
          average: 'Rolling average',
          band: 'Standard deviation',
          table: 'Show the numbers',
          headers: ['Ticket', 'Finished', 'Cycle time', 'Rolling average'],
        }}
      />,
    );
    const figure = screen.getByRole('figure', { name: 'Control chart' });
    const plot = figure.querySelector('.chart-plot') as HTMLElement;
    // The first dot sits at the plot's left edge (52) and top (12): 10 is the top tick.
    fireEvent.pointerMove(plot, { clientX: 55, clientY: 15 });
    expect(figure.querySelector('.chart-tooltip')?.textContent).toBe(
      'SHOP-1RefundsFinished t0Cycle time 10Rolling average 10',
    );
    // Far from every dot: nothing.
    fireEvent.pointerMove(plot, { clientX: 300, clientY: 200 });
    expect(figure.querySelector('.chart-tooltip')).toBeNull();
    const rows = within(figure)
      .getAllByRole('row')
      .map((r) => r.textContent);
    expect(rows).toEqual([
      'TicketFinishedCycle timeRolling average',
      'SHOP-1t01010',
      'SHOP-2t100047',
    ]);
    expect(within(figure).getByRole('link', { name: 'SHOP-2' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-2',
    );
  });
});

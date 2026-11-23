import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeSprintClient } from './fixtures';
import { SprintReportPage } from './SprintReportPage';

/** The report as a person reads it, on their own clock when `timeZone` is given (T-280). */
function open(locale: Locale = 'en', client = fakeSprintClient(), timeZone: string | null = null) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} timeZone={timeZone} onError={(e) => errors.push(e)}>
      <SprintReportPage boardId={7} sprintId={11} client={client} />
    </I18nProvider>,
  );
  return { errors, container: view.container, unmount: view.unmount };
}

describe('sprint charts on the report (M1-060)', () => {
  it('[RPT-001] shows the burndown with its guideline, the burnup and the velocity', async () => {
    open();
    const burndown = await screen.findByRole('figure', { name: 'Burndown' });
    expect(within(burndown).getByRole('img').getAttribute('aria-label')).toBe(
      'Burndown: 8h at the start, 3h remaining now; the guideline reaches zero on the planned last day.',
    );
    const table = within(burndown).getByRole('table');
    const rows = within(table).getAllByRole('row');
    // Ten days to the planned end; eight have happened.
    expect(rows).toHaveLength(11);
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['8h', '8h']);
    expect(
      within(rows[10] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['', '0h']);
    const burnup = screen.getByRole('figure', { name: 'Burnup' });
    expect(within(burnup).getByRole('img').getAttribute('aria-label')).toBe(
      'Burnup: 6h completed of 9h in scope.',
    );
    const velocity = screen.getByRole('figure', { name: 'Velocity' });
    expect(
      within(velocity)
        .getAllByRole('rowheader')
        .map((r) => r.textContent),
    ).toEqual(['Checkout Sprint 8', 'Checkout Sprint 9', 'Checkout Sprint 10']);
    expect(screen.getByText('Average completed: 9.7h')).toBeVisible();
  });

  it('[RPT-001] says when no sprint is completed yet, and when the charts cannot be read', async () => {
    const client = fakeSprintClient();
    client.velocity = async () => ({
      statistic: { statistic: 'ticketCount' },
      sprints: [],
      average: 0,
    });
    open('en', client);
    expect(
      await screen.findByText('Velocity appears once a sprint of this board is completed.'),
    ).toBeVisible();
    const failing = fakeSprintClient();
    failing.burndown = async () => {
      throw new Error('network');
    };
    open('en', failing);
    expect(await screen.findByText('The charts could not be loaded.')).toBeVisible();
  });

  it('[AGL-010] lists the tickets in columns, the estimate under a heading of its own (TR-11, TR-22)', async () => {
    open();
    const completed = await screen.findByRole('region', { name: 'Completed tickets' });
    const table = within(completed).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Key', 'Summary', 'Status', 'Estimate']);
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['CHK-2', 'Show the order total', 'Closed', '2h']);
    // The totals sit on a card of their own (TR-14).
    expect(screen.getByText('Committed at the start').closest('dl')).toHaveClass('glass-card');
  });

  it('[AGL-010] says whether the sprint still runs or finished, and its planned dates on the person’s clock (S3-ST-5)', async () => {
    // Planned from Oct 26, started on Oct 27: the report gives the planned start, as the backlog.
    const running = open('en', fakeSprintClient(), 'UTC');
    expect(await screen.findByText('In progress: Oct 26, 2026 to Nov 9, 2026.')).toBeVisible();
    running.unmount();
    const closed = fakeSprintClient();
    const report = closed.report;
    closed.report = async (id) => {
      const read = await report(id);
      return {
        ...read,
        sprint: { ...read.sprint, state: 'closed', completedAt: '2026-11-10T16:00:00Z' },
      };
    };
    const finished = open('en', closed, 'UTC');
    expect(
      await screen.findByText('Finished on Nov 10, 2026. Planned for Oct 26, 2026 to Nov 9, 2026.'),
    ).toBeVisible();
    finished.unmount();
    // At UTC+14 it finished on the 11th, though it was still the 10th in London.
    const far = open('es', closed, 'Pacific/Kiritimati');
    expect(
      await screen.findByText(
        'Terminó el 11 nov 2026. Estaba previsto del 26 oct 2026 al 9 nov 2026.',
      ),
    ).toBeVisible();
    far.unmount();
    // With no planned start, the day it started stands in.
    const unplanned = fakeSprintClient();
    const read = unplanned.report;
    unplanned.report = async (id) => {
      const got = await read(id);
      return { ...got, sprint: { ...got.sprint, startAt: null } };
    };
    open('en', unplanned, 'UTC');
    expect(await screen.findByText('In progress: Oct 27, 2026 to Nov 9, 2026.')).toBeVisible();
  });

  it('[RPT-001] explains a sprint with no estimates instead of drawing empty charts and zero totals (TR-13)', async () => {
    const client = fakeSprintClient();
    const report = client.report;
    client.report = async (id) => {
      const read = await report(id);
      const none = (list: typeof read.completed) =>
        list.map((x) => ({ ...x, estimate: null, estimateAtEntry: null, estimateChanged: false }));
      return {
        ...read,
        completed: none(read.completed),
        notCompleted: none(read.notCompleted),
        totals: {
          committed: 0,
          added: 0,
          removed: 0,
          completed: 0,
          notCompleted: 0,
          estimateChange: 0,
          remaining: 0,
        },
      };
    };
    const burndown = client.burndown;
    client.burndown = async (id) => {
      const read = await burndown(id);
      return {
        ...read,
        start: { ...read.start, remaining: 0, scope: 0 },
        guideline: { ...read.guideline, from: { ...read.guideline.from, value: 0 } },
        days: read.days.map((d) => ({ ...d, remaining: 0, scope: 0, completed: 0 })),
        end: { ...read.end, remaining: 0, scope: 0, completed: 0 },
      };
    };
    let velocityRead = false;
    client.velocity = async () => {
      const read = {
        statistic: { statistic: 'originalEstimate' as const },
        sprints: [
          ...(await fakeSprintClient().velocity(7)).sprints
            .slice(0, 1)
            .map((x) => ({ ...x, committed: 0, completed: 0 })),
        ],
        average: 0,
      };
      velocityRead = true;
      return read;
    };
    const { container } = open('en', client);
    await screen.findByText('No estimates to add up');
    await waitFor(() => expect(velocityRead).toBe(true));
    await screen.findByRole('link', { name: 'CHK-2' });
    // One card across the row for both charts, not the same card twice side by side.
    expect(screen.getAllByText('No estimates to add up')).toHaveLength(1);
    expect(container.querySelectorAll('.sprint-chart')).toHaveLength(1);
    expect(screen.queryByRole('figure', { name: 'Burndown' })).toBeNull();
    expect(screen.queryByRole('figure', { name: 'Velocity' })).toBeNull();
    expect(screen.queryByText('Committed at the start')).toBeNull();
    // The tickets are still listed.
    expect(screen.getByRole('link', { name: 'CHK-2' })).toBeVisible();
  });

  it('[RPT-001] fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open();
    await screen.findByRole('figure', { name: 'Burndown' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-001] every text goes through the catalogue (en-XA)', async () => {
    const { container, errors } = open('en-XA');
    await screen.findAllByRole('figure');
    await screen.findAllByRole('table');
    // Dates, numbers and keys are data, and so are the fake's summaries and statuses.
    const data = new Set([
      'Show the order total',
      'Accept card payments',
      'Refunds',
      'New',
      'Closed',
    ]);
    const texts = visibleTexts(container).filter((t) => !/\d/.test(t) && !data.has(t));
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

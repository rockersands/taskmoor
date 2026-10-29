import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeSprintClient } from './fixtures';
import { SprintReportPage } from './SprintReportPage';

function open(locale: Locale = 'en', client = fakeSprintClient()) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SprintReportPage boardId={7} sprintId={11} client={client} />
    </I18nProvider>,
  );
  return { errors, container: view.container };
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

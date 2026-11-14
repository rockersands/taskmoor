import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { PlanCriticalPath } from '../plans/client';
import { CriticalPathList } from './CriticalPathList';
import { criticalPathFixture } from './criticalFixtures';

const show = (
  path: PlanCriticalPath | null,
  extra: { failed?: boolean; locale?: 'en' | 'es' } = {},
) =>
  render(
    <I18nProvider locale={extra.locale ?? 'en'}>
      <CriticalPathList path={path} failed={extra.failed ?? false} headingId="path" />
    </I18nProvider>,
  );

/**
 * The critical path in words (PLN-011; ADR-122 stage 9), for the keyboard, screen readers and
 * phones: the fixture plan's path is SHOP-2 then SHOP-3, which ends the plan on 20 Nov.
 */
describe('the critical path in words (PLN-011)', () => {
  it('[PLN-011] says how many tickets are on the path and when the plan ends, then each chain in order', () => {
    show(criticalPathFixture());
    const section = screen.getByRole('region', { name: 'Critical path' });
    expect(
      within(section).getByText('2 tickets are on the critical path. The plan ends Nov 20, 2026.'),
    ).toBeVisible();
    expect(
      within(section).getByText(/^It covers the tickets this plan shows you, whatever the filters/),
    ).toBeVisible();
    expect(within(section).getByText('Chain 1')).toBeVisible();
    const chain = section.querySelector('.critical-steps') as HTMLElement;
    const steps = within(chain)
      .getAllByRole('listitem')
      .map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
    expect(steps).toEqual([
      'SHOP-2 Build the shop page starts Nov 2, 2026, ends Nov 10, 2026 (a dependency before it is 2 days late)',
      'SHOP-3 Take payments then starts Nov 9, 2026, ends Nov 20, 2026, the plan’s end.',
    ]);
    expect(
      within(section).getByRole('link', { name: 'SHOP-2 Build the shop page' }),
    ).toHaveAttribute('href', expect.stringContaining('#/tickets/SHOP-2'));
  });

  it('[PLN-011] [QRY-008] only counts what it does not name: circles, work elsewhere, tickets without dates', () => {
    show({
      ...criticalPathFixture(),
      more: 3,
      counts: { critical: 5, cycles: 2, undated: 1, waitsElsewhere: 1 },
    });
    expect(screen.getByText('3 more tickets are on the path and not listed here.')).toBeVisible();
    expect(
      screen.getByText('2 tickets are in a circle of dependencies and have no slack.'),
    ).toBeVisible();
    expect(
      screen.getByText(
        '1 ticket waits for work outside this plan or not shown to you; that work is not counted.',
      ),
    ).toBeVisible();
    expect(screen.getByText('1 open ticket has no dates and is left out.')).toBeVisible();
  });

  it('[PLN-011] says there is no path when no open ticket has dates, while it is read, and when it fails', () => {
    const { unmount } = show({
      ...criticalPathFixture(),
      planEnd: null,
      chains: [],
      counts: { critical: 0, cycles: 0, undated: 4, waitsElsewhere: 0 },
      listed: [],
    });
    expect(
      screen.getByText('No open ticket of this plan has dates, so there is no critical path.'),
    ).toBeVisible();
    unmount();
    const loading = show(null);
    expect(screen.getByText('Working out the critical path…')).toBeVisible();
    loading.unmount();
    show(null, { failed: true });
    expect(screen.getByRole('alert')).toHaveTextContent('The critical path could not be read.');
  });

  it('[PLN-011] speaks Spanish from the catalogue', () => {
    show(criticalPathFixture(), { locale: 'es' });
    expect(screen.getByRole('region', { name: 'Ruta crítica' })).toBeVisible();
    expect(
      screen.getByText(/2 tickets están en la ruta crítica\. El plan termina el/),
    ).toBeVisible();
  });
});

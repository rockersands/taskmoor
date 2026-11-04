import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { PlanCalendar, PlanFilters, PlanTimeline } from './client';
import { fakePlanClient, planItems } from './fixtures';
import { PlanCalendarPage } from './PlanCalendarPage';
import { PlanTimelinePage } from './PlanTimelinePage';

/** Answers held until the test lets them go, in any order. */
function held<T>() {
  const waiting = new Map<string, (value: T) => void>();
  return {
    ask: (key: string) => new Promise<T>((resolve) => waiting.set(key, resolve)),
    answer: (key: string, value: T) => waiting.get(key)?.(value),
  };
}

const now = () => new Date('2026-11-04T09:00:00Z');

describe('a plan view read again (PLN-012)', () => {
  it('[PLN-012] draws the timeline for the latest filters, whatever answers last', async () => {
    const inner = fakePlanClient();
    const plan = await inner.get(12);
    const answers = held<PlanTimeline>();
    const client = {
      ...inner,
      timeline: (_id: number, f: PlanFilters) => answers.ask(f.track ?? ''),
    };
    const page = (filters: PlanFilters) => (
      <I18nProvider locale="en">
        <PlanTimelinePage
          id={12}
          plan={plan}
          filters={filters}
          client={client}
          now={now}
          group={null}
        />
      </I18nProvider>
    );
    const { rerender } = render(page({ track: 'SHOP' }));
    rerender(page({ track: 'OPS' }));
    const items = planItems();
    const data = (keys: string[]) => ({
      query: 'q',
      items: items.filter((i) => keys.includes(i.key)),
      links: [],
      blockersElsewhere: [],
      tracks: [],
      markers: { sprints: [], releases: [] },
      truncated: false,
    });
    await act(async () => answers.answer('OPS', data(['OPS-4'])));
    expect(await screen.findByRole('link', { name: 'OPS-4' })).toBeVisible();
    // The slow answer for the filter left behind arrives last, and is not drawn.
    await act(async () => answers.answer('SHOP', data(['SHOP-2'])));
    expect(screen.queryByRole('link', { name: 'SHOP-2' })).toBeNull();
    expect(screen.getByRole('link', { name: 'OPS-4' })).toBeVisible();
  });

  it('[PLN-012] draws the calendar for the latest filters, whatever answers last', async () => {
    const inner = fakePlanClient();
    const plan = await inner.get(12);
    const answers = held<PlanCalendar>();
    const client = {
      ...inner,
      calendar: (_id: number, f: PlanFilters) => answers.ask(f.track ?? ''),
    };
    const page = (filters: PlanFilters) => (
      <I18nProvider locale="en">
        <PlanCalendarPage id={12} plan={plan} filters={filters} client={client} now={now} />
      </I18nProvider>
    );
    const { rerender } = render(page({ track: 'SHOP' }));
    rerender(page({ track: 'OPS' }));
    const entry = (key: string, summary: string) => ({
      id: 1,
      key,
      summary,
      type: 'Feature',
      stage: 'new' as const,
      start: null,
      due: '2026-11-12',
      trackId: 1,
    });
    const data = (tickets: ReturnType<typeof entry>[]) => ({
      query: 'q',
      tickets,
      tracks: [],
      sprints: [],
      releases: [],
      truncated: false,
    });
    await act(async () => answers.answer('OPS', data([entry('OPS-4', 'Scale the servers')])));
    expect(
      await screen.findByRole('link', { name: 'OPS-4 Scale the servers, due this day' }),
    ).toBeVisible();
    await act(async () => answers.answer('SHOP', data([entry('SHOP-2', 'Build the shop page')])));
    expect(screen.queryByRole('link', { name: /^SHOP-2/ })).toBeNull();
  });
});

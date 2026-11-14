import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { dayNumber } from '../timeline/client';
import { type CalendarEntries, CalendarView, monthOf } from './CalendarView';
import type { CalendarTicket, Moved } from './client';

const ticket = (id: number): CalendarTicket => ({
  id,
  key: `CAL-${id}`,
  summary: `Ticket ${id}`,
  type: 'Feature',
  stage: 'new',
  start: null,
  due: '2026-11-05',
});

function renderBusyDay(locale: Locale) {
  render(
    <I18nProvider locale={locale}>
      <CalendarView
        data={{
          tickets: Array.from({ length: 9 }, (_, i) => ticket(i + 1)),
          sprints: [],
          releases: [],
          truncated: false,
        }}
        month={monthOf(dayNumber('2026-11-05'))}
        onMonth={() => {}}
        move={async () => ({ ok: true })}
        reload={() => {}}
        now={() => new Date('2026-11-04T09:00:00Z')}
        truncatedText="cut"
      />
    </I18nProvider>,
  );
}

describe('a busy calendar day (PLN-012)', () => {
  it.each(['en', 'es'] as const)(
    '[PLN-012] names its "more" button with the words it shows, in %s',
    (locale) => {
      renderBusyDay(locale);
      const more = screen.getByRole('button', { name: /^3 / });
      const shown = more.textContent ?? '';
      expect(shown).toMatch(/^3 /);
      // Label in Name (WCAG 2.5.3): speech input finds the button by what it shows.
      expect(more.getAttribute('aria-label')?.startsWith(shown)).toBe(true);
    },
  );
});

/**
 * A calendar drawn from data the test hands it, whose moves wait for the test to answer them:
 * `view` draws it again with other data, `answer` answers the move under way.
 */
function controlledCalendar() {
  const pending: { answer: (moved: Moved) => void } = { answer: () => {} };
  const view = (data: CalendarEntries) => (
    <I18nProvider locale="en">
      <CalendarView
        data={data}
        month={monthOf(dayNumber('2026-11-05'))}
        onMonth={() => {}}
        move={() =>
          new Promise<Moved>((resolve) => {
            pending.answer = resolve;
          })
        }
        reload={() => {}}
        now={() => new Date('2026-11-04T09:00:00Z')}
        truncatedText="cut"
      />
    </I18nProvider>
  );
  const before = { tickets: [ticket(1)], sprints: [], releases: [], truncated: false };
  const { rerender } = render(view(before));
  return {
    before,
    redraw: (data: CalendarEntries) => rerender(view(data)),
    answer: (moved: Moved) => act(async () => pending.answer(moved)),
  };
}

describe('the keyboard with a moved entry (T-229)', () => {
  it('[AGL-017] waits through drawings before the move’s own reading, then goes with the entry', async () => {
    const user = userEvent.setup();
    const { before, redraw, answer } = controlledCalendar();
    screen.getByRole('link', { name: 'CAL-1 Ticket 1, due this day' }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    // The page draws the same tickets again, before and after the answer: neither is the reading.
    redraw({ ...before });
    await answer({ ok: true });
    redraw({ ...before });
    redraw({ ...before, tickets: [{ ...ticket(1), due: '2026-11-06' }] });
    expect(
      within(screen.getByRole('listitem', { name: /^Nov 6, 2026/ })).getByRole('link', {
        name: 'CAL-1 Ticket 1, due this day',
      }),
    ).toHaveFocus();
  });

  it('[AGL-017] leaves the keyboard where someone put it while the move was under way', async () => {
    const user = userEvent.setup();
    const { before, redraw, answer } = controlledCalendar();
    screen.getByRole('link', { name: 'CAL-1 Ticket 1, due this day' }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    const next = screen.getByRole('button', { name: 'Next month' });
    next.focus();
    await answer({ ok: true });
    redraw({ ...before, tickets: [{ ...ticket(1), due: '2026-11-06' }] });
    expect(next).toHaveFocus();
  });
});

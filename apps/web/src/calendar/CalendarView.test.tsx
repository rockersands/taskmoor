import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { dayNumber } from '../timeline/client';
import { CalendarView, monthOf } from './CalendarView';
import type { CalendarTicket } from './client';

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
      const more = screen.getByRole('button', { expanded: false });
      const shown = more.textContent ?? '';
      expect(shown).toMatch(/^3 /);
      // Label in Name (WCAG 2.5.3): speech input finds the button by what it shows.
      expect(more.getAttribute('aria-label')?.startsWith(shown)).toBe(true);
    },
  );
});

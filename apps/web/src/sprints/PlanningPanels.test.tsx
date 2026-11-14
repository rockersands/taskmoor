import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { useTimeZone } from '../test/timeZone';
import { PlanningPanels } from './PlanningPanels';

const panels = {
  outcomes: [],
  releases: [
    { id: 50, name: 'Checkout 2.0', trackId: 1, releaseDate: '2026-10-13', tickets: 4 },
    { id: 51, name: 'Checkout 2.1', trackId: 1, releaseDate: null, tickets: 1 },
  ],
};

function renderPanels(locale: 'en' | 'es') {
  render(
    <I18nProvider locale={locale}>
      <PlanningPanels panels={panels} failed={false} filter={null} onFilter={vi.fn()} over={null} />
    </I18nProvider>,
  );
}

// The backlog's release panel reads a release's date as the Releases list does, in the person's
// locale and on its own calendar day, not 'due 2026-10-13' (TR-29, T-240).
describe('the backlog’s releases panel dates (AGL-008, T-240)', () => {
  useTimeZone('America/Los_Angeles');

  it('[AGL-008] [NFR-006] reads a release’s date in English', () => {
    renderPanels('en');
    expect(screen.getByRole('button', { name: /Checkout 2\.0/ })).toHaveTextContent(
      '4 tickets, due Oct 13, 2026',
    );
    expect(screen.getByRole('button', { name: /Checkout 2\.1/ })).toHaveTextContent('1 ticket');
  });

  it('[AGL-008] [NFR-006] reads a release’s date in Spanish', () => {
    renderPanels('es');
    expect(screen.getByRole('button', { name: /Checkout 2\.0/ })).toHaveTextContent(
      '4 tickets, vence 13 oct 2026',
    );
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { useTimeZone } from '../test/timeZone';
import { BoardCardItem, type CardActions } from './BoardCard';
import type { BoardCard } from './client';

const card: BoardCard = {
  id: 101,
  key: 'SHOP-1',
  summary: 'Refunds to the original card',
  status: { id: 1, name: 'To do' },
  ticketType: { id: 1, name: 'Task', icon: null, color: null },
  columnId: 'todo',
  laneId: 'all',
  rank: 'a001',
  version: 1,
  colour: null,
  fields: { dueDate: '2026-10-13' },
  daysInColumn: null,
  mayEdit: true,
};

const actions: CardActions = {
  grab: vi.fn(),
  keyDown: vi.fn(),
  open: vi.fn(),
  editTitle: vi.fn(),
  toggleMenu: vi.fn(),
  linkRef: vi.fn(),
  pencilRef: vi.fn(),
};

function renderCard(locale: 'en' | 'es') {
  render(
    <I18nProvider locale={locale}>
      <ul>
        <BoardCardItem
          card={card}
          place={1}
          of={1}
          hintId="hint"
          tabbable
          dragging={false}
          dropBefore={false}
          busy={false}
          menuOpen={false}
          editor={null}
          menu={null}
          progress={undefined}
          skipBefore={0}
          actions={actions}
        />
      </ul>
    </I18nProvider>,
  );
  return screen.getByRole('listitem');
}

// A card's due date reads as everywhere else, in the person's locale and on its own calendar
// day, never 'Due 2026-10-13' (T-240).
describe('a card’s due date (AGL-006, T-240)', () => {
  useTimeZone('America/Los_Angeles');

  it('[AGL-006] [NFR-006] reads in English', () => {
    expect(renderCard('en')).toHaveTextContent('Due Oct 13, 2026');
  });

  it('[AGL-006] [NFR-006] reads in Spanish', () => {
    expect(renderCard('es')).toHaveTextContent('Vence 13 oct 2026');
  });
});

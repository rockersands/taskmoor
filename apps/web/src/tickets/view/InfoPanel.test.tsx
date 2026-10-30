import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import type { TicketInfo } from './client';
import { INFO } from './fixtures';
import { InfoPanel } from './InfoPanel';

function renderPanel(info: TicketInfo | null = INFO, locale: Locale = 'en') {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <InfoPanel
        ticketId={41}
        client={{
          info: async () => {
            if (!info) throw new Error('unreachable');
            return info;
          },
        }}
        revision={0}
      />
    </I18nProvider>,
  );
  return { errors, container: view.container };
}

describe('InfoPanel (M1-125)', () => {
  it('[CORE-012] shows the first response, the days since the last comment and the participants', async () => {
    renderPanel();
    const panel = await screen.findByRole('region', { name: 'Info' });
    expect(within(panel).getByText('Date of first response')).toBeVisible();
    expect(within(panel).getByText('1 day')).toBeVisible();
    expect(within(panel).getByText('Ada Lovelace and Grace Hopper')).toBeVisible();
  });

  it('[CORE-012] (1) lists the time in each status with how often the ticket entered it', async () => {
    renderPanel();
    const table = await screen.findByRole('table', { name: 'Time in status' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'To do1 h 30 min1',
      'In progress2 d 4 h2',
      'In reviewUnder a minute1',
    ]);
  });

  it('[CORE-012] says when nobody has answered or commented', async () => {
    renderPanel({
      firstResponse: null,
      lastComment: null,
      daysSinceLastComment: null,
      participants: [],
      timeInStatus: [],
    });
    expect(await screen.findByText('No response yet')).toBeVisible();
    expect(screen.getByText('No comments')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('[CORE-012] shows nothing when the info cannot be read', async () => {
    const { container } = renderPanel(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });

  it('passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPanel(INFO, 'en-XA');
    await screen.findByRole('table');
    const texts = visibleTexts(container).filter(
      (t) =>
        !/\d/.test(t) &&
        !['Ada Lovelace', 'Grace Hopper', 'To do', 'In progress', 'In review'].some((n) =>
          t.includes(n),
        ),
    );
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('fits a small phone', async () => {
    setViewportWidth(360);
    renderPanel();
    expect(await screen.findByRole('table', { name: 'Time in status' })).toBeVisible();
  });
});

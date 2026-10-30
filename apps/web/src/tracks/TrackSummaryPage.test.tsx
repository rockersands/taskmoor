import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeTrackClient, SHOP_SUMMARY } from './fixtures';
import { TrackSummaryPage } from './TrackSummaryPage';

function open(locale: Locale = 'en', client = fakeTrackClient()) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <TrackSummaryPage trackKey="SHOP" client={client} />
    </I18nProvider>,
  );
  return { errors, container: view.container };
}

describe('track summary page (M1-064)', () => {
  it('[RPT-006] every number opens the search that counts it', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Shop (SHOP)' })).toBeVisible();
    const open26 = screen.getByRole('link', { name: '26' });
    expect(open26).toHaveAttribute(
      'href',
      `#/search?q=${encodeURIComponent('track = SHOP AND closeReason IS EMPTY').replace(/%20/g, '+')}`,
    );
    const priorities = screen.getByRole('region', { name: 'Open by priority' });
    expect(
      within(priorities)
        .getAllByRole('link')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual([
      'High 8, open the search',
      'Medium 12, open the search',
      'No priority 6, open the search',
    ]);
    const assignees = screen.getByRole('region', { name: 'Open by assignee' });
    expect(
      within(assignees).getByRole('link', { name: 'Unassigned 7, open the search' }),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'By stage' })).toHaveTextContent(
      'New 14Active 12Closed 120',
    );
  });

  it('[RPT-006] says a count past the search cap is at least that', async () => {
    const capped = {
      ...SHOP_SUMMARY,
      overview: SHOP_SUMMARY.overview.map((i) =>
        i.id === 'open' ? { ...i, count: 10_000, exact: false } : i,
      ),
    };
    open('en', fakeTrackClient(capped));
    expect(await screen.findByRole('link', { name: '10,000+' })).toBeVisible();
  });

  it('[RPT-006] says when the track cannot be read', async () => {
    open('en', fakeTrackClient(null));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This track does not exist, or you cannot see it.',
    );
  });

  it('[RPT-006] fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open();
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-006] every text goes through the catalogue (en-XA)', async () => {
    const { container, errors } = open('en-XA');
    await screen.findByRole('heading', { level: 1 });
    const data = new Set(['High', 'Medium', 'Bug', 'Feature', 'Ada Lovelace', 'Grace Hopper']);
    const texts = visibleTexts(container).filter((t) => !/\d/.test(t) && !data.has(t));
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

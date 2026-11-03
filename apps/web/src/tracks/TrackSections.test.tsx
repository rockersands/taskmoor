import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeTrackClient } from './fixtures';
import { TrackFilesPage } from './TrackFilesPage';
import { TrackLayout } from './TrackLayout';
import { TrackNavList } from './TrackNavList';
import { TracksPage } from './TracksPage';

const inEnglish = (node: React.ReactNode) =>
  render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('a track is one place with its sections (ADR-116)', () => {
  it('[CORE-001] shares one tab bar, with the current section marked', () => {
    inEnglish(
      <TrackLayout trackKey="SHOP" section="timeline">
        <p>page</p>
      </TrackLayout>,
    );
    const bar = screen.getByRole('navigation', { name: 'Sections of SHOP' });
    const names = within(bar)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual([
      'Summary',
      'Board',
      'Backlog',
      'List',
      'Calendar',
      'Timeline',
      'Releases',
      'Files and links',
      'Statistics',
    ]);
    expect(within(bar).getByRole('link', { name: 'Timeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(bar).getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/board',
    );
  });

  it('[CORE-001] lists the tracks the person can see and finds them by name or key', async () => {
    inEnglish(<TracksPage client={fakeTrackClient()} />);
    expect(await screen.findByRole('link', { name: /Shop/ })).toHaveAttribute(
      'href',
      '#/tracks/SHOP',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Tracks' })).toBeVisible();
    expect(screen.getByLabelText('Find a track')).toBeVisible();
  });

  it('[CORE-001] marks the current track in the sidebar, also from a ticket inside it', async () => {
    inEnglish(<TrackNavList hash="#/tickets/SHOP-41" client={fakeTrackClient()} />);
    expect(await screen.findByRole('link', { name: 'Shop' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Web' })).not.toHaveAttribute('aria-current');
  });

  it('[CORE-001] keeps a long list short, with a link to all of them', async () => {
    const client = fakeTrackClient();
    client.list = async () =>
      Array.from({ length: 12 }, (_, i) => ({ key: `T${i}`, name: `Track ${i}`, owner: null }));
    inEnglish(<TrackNavList hash="#/tracks/T11" client={client} />);
    expect(await screen.findByRole('link', { name: 'All 12 tracks' })).toHaveAttribute(
      'href',
      '#/tracks',
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent('Track 11');
  });

  it("[CORE-001] shows a track's files and links, each leading to its ticket", async () => {
    inEnglish(<TrackFilesPage trackKey="SHOP" client={fakeTrackClient()} />);
    const files = await screen.findByRole('region', { name: 'Files' });
    expect(within(files).getByText('invoice.pdf')).toBeVisible();
    expect(within(files).getByRole('link', { name: 'SHOP-41' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-41',
    );
    const links = screen.getByRole('region', { name: 'Web links' });
    await waitFor(() =>
      expect(within(links).getByRole('link', { name: 'Design' })).toHaveAttribute(
        'href',
        'https://example.com/design',
      ),
    );
  });

  it('[CORE-001] says what belongs there when a track has no files or links', async () => {
    const client = fakeTrackClient();
    client.files = async () => ({ attachments: [], links: [], truncated: false });
    inEnglish(<TrackFilesPage trackKey="SHOP" client={client} />);
    expect(await screen.findByText('No files or links yet')).toBeVisible();
  });
});

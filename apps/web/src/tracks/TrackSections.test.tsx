import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { boardClient } from '../boards/client';
import { BOARD } from '../boards/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { onRouteChange } from '../routing/router';
import { BoardInTrack, NoBacklog, Redirect } from './BoardInTrack';
import { fakeTrackClient } from './fixtures';
import { TrackFilesPage } from './TrackFilesPage';
import { TrackLayout } from './TrackLayout';
import { TracksPage } from './TracksPage';
import { trackSectionsChanged } from './trackSections';

const inEnglish = (node: React.ReactNode) =>
  render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('a track is one place with its sections (ADR-116)', () => {
  it('[CORE-001] shares one tab bar, with the current section marked', async () => {
    inEnglish(
      <TrackLayout trackKey="SHOP" section="timeline" client={fakeTrackClient()}>
        <p>page</p>
      </TrackLayout>,
    );
    const bar = screen.getByRole('navigation', { name: 'Sections of SHOP' });
    await within(bar).findByRole('link', { name: 'Backlog' });
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

  it('[CORE-002] shows no Backlog tab on a Kanban track, not even while it finds out', async () => {
    let answer: (sections: { backlog: boolean; sprints: boolean }) => void = () => {};
    const client = fakeTrackClient();
    client.sections = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    inEnglish(
      <TrackLayout trackKey="KAN" section="board" client={client}>
        <p>page</p>
      </TrackLayout>,
    );
    const bar = screen.getByRole('navigation', { name: 'Sections of KAN' });
    expect(within(bar).queryByRole('link', { name: 'Backlog' })).toBeNull();
    await act(async () => answer({ backlog: false, sprints: false }));
    expect(within(bar).queryByRole('link', { name: 'Backlog' })).toBeNull();
    expect(within(bar).getByRole('link', { name: 'Board' })).toBeVisible();
  });

  it("[CORE-002] brings Backlog back or takes it away at once when the board's kind changes", async () => {
    const client = fakeTrackClient(undefined, { sections: { backlog: false, sprints: false } });
    const sections = vi.fn(async () => ({ backlog: false, sprints: false }));
    client.sections = sections;
    inEnglish(
      <TrackLayout trackKey="CHG" section="board" client={client}>
        <p>page</p>
      </TrackLayout>,
    );
    const bar = screen.getByRole('navigation', { name: 'Sections of CHG' });
    await waitFor(() => expect(sections).toHaveBeenCalledTimes(1));
    expect(within(bar).queryByRole('link', { name: 'Backlog' })).toBeNull();

    sections.mockResolvedValue({ backlog: true, sprints: true });
    act(() => trackSectionsChanged('CHG'));
    expect(await within(bar).findByRole('link', { name: 'Backlog' })).toHaveAttribute(
      'href',
      '#/tracks/CHG/backlog',
    );

    sections.mockResolvedValue({ backlog: false, sprints: false });
    act(() => trackSectionsChanged('chg'));
    await waitFor(() => expect(within(bar).queryByRole('link', { name: 'Backlog' })).toBeNull());
  });

  it("[CORE-002] says plainly that a track has no backlog at the backlog's address", () => {
    inEnglish(<NoBacklog board={{ ...BOARD, mayConfigure: false }} />);
    expect(screen.getByText('This track has no backlog')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the board' })).toHaveAttribute(
      'href',
      '#/tracks/SHOP/board',
    );
    expect(screen.queryByRole('link', { name: "Change the board's kind" })).toBeNull();
  });

  it('[CORE-002] offers those who may configure the board to change its kind', () => {
    inEnglish(<NoBacklog board={{ ...BOARD, mayConfigure: true }} />);
    expect(screen.getByRole('link', { name: "Change the board's kind" })).toHaveAttribute(
      'href',
      `#/boards/${BOARD.id}/settings`,
    );
  });

  it("[CORE-001] plays a section's entry each time the section changes, keeping its contents", async () => {
    const show = (section: 'board' | 'backlog') => (
      <I18nProvider locale="en">
        <TrackLayout trackKey="SHOP" section={section} client={fakeTrackClient()}>
          <input aria-label="Kept while the tab changes" />
        </TrackLayout>
      </I18nProvider>
    );
    const { rerender } = render(show('board'));
    const field = screen.getByRole('textbox', { name: 'Kept while the tab changes' });
    const region = field.parentElement as HTMLElement;
    expect(region).toHaveClass('motion-rise');
    fireEvent.animationEnd(region);
    expect(region).not.toHaveClass('motion-rise');
    rerender(show('backlog'));
    expect(screen.getByRole('textbox', { name: 'Kept while the tab changes' })).toBe(field);
    expect(region).toHaveClass('motion-rise');
    await screen.findByRole('navigation', { name: /SHOP/ });
  });

  it("[CORE-001] a board's page starts once, in its track's tabs", async () => {
    const board = vi.spyOn(boardClient, 'board').mockResolvedValue(BOARD);
    let starts = 0;
    function Page() {
      useEffect(() => {
        starts += 1;
      }, []);
      return <p>the page</p>;
    }
    inEnglish(
      <BoardInTrack boardId={BOARD.id} section="board">
        <Page />
      </BoardInTrack>,
    );
    expect(screen.queryByText('the page')).toBeNull();
    expect(await screen.findByText('the page')).toBeVisible();
    expect(screen.getByRole('navigation', { name: /^Sections of / })).toBeVisible();
    expect(starts).toBe(1);
    board.mockRestore();
  });

  it('[CORE-001] a redirect tells the app, so the page it leads to shows', () => {
    const heard = vi.fn();
    const stop = onRouteChange(heard);
    inEnglish(<Redirect to="#/tracks/SHOP/statistics" />);
    stop();
    expect(heard).toHaveBeenCalled();
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

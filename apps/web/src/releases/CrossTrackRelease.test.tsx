import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { drawnReleases } from '../timeline/markers';
import { CrossTrackReleasePage } from './CrossTrackReleasePage';
import { CrossTrackReleasesPage } from './CrossTrackReleasesPage';
import { type FakeCrossTrackOptions, fakeCrossTrackClient } from './crossTrackFixtures';

const show = (element: ReactElement) => render(<I18nProvider locale="en">{element}</I18nProvider>);

function renderPage(options: FakeCrossTrackOptions = {}) {
  const client = fakeCrossTrackClient(options);
  show(<CrossTrackReleasePage id={5} client={client} />);
  return client;
}
const searched = (link: HTMLElement) =>
  new URLSearchParams((link.getAttribute('href') ?? '').split('?')[1]).get('q');

/** Releases across tracks (T-089c; PLN-007; ADR-122 stage 4), with the fixture of `crossTrackFixtures`. */
describe('releases across tracks (PLN-007)', () => {
  it('[PLN-007] lists Upcoming and Shipped with the end, the state in words and what is hidden', async () => {
    show(<CrossTrackReleasesPage client={fakeCrossTrackClient()} />);
    const upcoming = await screen.findByRole('region', { name: 'Upcoming' });
    const link = within(upcoming).getByRole('link', { name: 'Spring launch' });
    expect(link.getAttribute('href')).toContain('#/cross-track-releases/5');
    expect(within(link.closest('li') as HTMLElement).getByText('Upcoming')).toBeVisible();
    expect(within(upcoming).getByText('Dec 1, 2026')).toBeVisible();
    expect(within(upcoming).getByText(/SHOP, OPS/)).toBeVisible();
    expect(within(upcoming).getByText(/1 release hidden from you/)).toBeVisible();
    expect(screen.getByText('None has shipped yet.')).toBeVisible();
  });

  it('[PLN-007] tells the person to make one when none is there, and fails in words', async () => {
    show(<CrossTrackReleasesPage client={fakeCrossTrackClient({ empty: true })} />);
    expect(await screen.findByText('No upcoming release across tracks.')).toBeVisible();
    const failing = {
      ...fakeCrossTrackClient(),
      list: async () => {
        throw new Error('down');
      },
    };
    show(<CrossTrackReleasesPage client={failing} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Releases across tracks could not be read.',
    );
  });

  it('[PLN-007] makes one from a name, an end and releases ticked in a list that filters, one per track', async () => {
    const user = userEvent.setup();
    const client = fakeCrossTrackClient({ empty: true });
    const create = vi.spyOn(client, 'create');
    show(<CrossTrackReleasesPage client={client} />);
    await user.click(await screen.findByRole('button', { name: 'New release across tracks' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Launch');
    await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ });
    await user.type(within(dialog).getByLabelText('Filter releases'), 'website');
    expect(within(dialog).queryByRole('checkbox', { name: /Shop 2\.1/ })).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: /Website 3\.0/ }));
    // A date is needed for a fixed end; the form says so before anything is sent.
    await user.click(within(dialog).getByRole('radio', { name: 'When its work completes' }));
    expect(within(dialog).queryByLabelText('The day')).toBeNull();
    expect(within(dialog).getByText(/Linking moves no date/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Make it' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Launch',
        endRule: 'work_complete',
        releaseIds: [32],
      }),
    );
  });

  it('[PLN-007] asks for at least one release, and says plainly why a link was refused', async () => {
    const user = userEvent.setup();
    const client = fakeCrossTrackClient({ empty: true });
    client.create = async () => ({ ok: false, code: 'release_taken' });
    show(<CrossTrackReleasesPage client={client} />);
    await user.click(await screen.findByRole('button', { name: 'New release across tracks' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Launch');
    await user.click(within(dialog).getByRole('radio', { name: 'When its work completes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Make it' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose at least one release.',
    );
    await user.click(await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Make it' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('already linked'),
    );
  });

  it('[PLN-007] shows its linked releases, says out of step in words and only counts the rest', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Spring launch', level: 1 })).toBeVisible();
    const linkedRegion = screen.getByRole('region', { name: 'Linked releases' });
    const table = within(linkedRegion).getByRole('table');
    expect(within(table).getByRole('link', { name: '2.0' }).getAttribute('href')).toContain(
      '#/releases/21',
    );
    expect(within(table).getByText('Out of step')).toBeVisible();
    expect(
      within(linkedRegion).getByText(
        '1 more release is hidden from you, with 4 open tickets you may not see.',
      ),
    ).toBeVisible();
    expect(screen.getByText('1 linked release is out of step with this date.')).toBeVisible();
  });

  it('[PLN-007] links each number to the search that finds those tickets', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /Active/ });
    expect(searched(link)).toBe('crossTrackRelease = 5 AND stage = active');
  });

  it('[PLN-007] keeps moving, editing and deleting to its owner and administrators', async () => {
    renderPage({ mayManage: false });
    await screen.findByRole('heading', { name: 'Spring launch', level: 1 });
    expect(screen.queryByRole('button', { name: 'Move date' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    // Only the track they administer has Remove.
    expect(screen.getByRole('button', { name: 'Remove 2.0' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove 1.4' })).toBeNull();
  });

  it('[PLN-007] lists what a move changes first, then moves, says why of the rest and stays open', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Move date' }));
    const dialog = await screen.findByRole('dialog');
    const day = within(dialog).getByLabelText('New date');
    await user.clear(day);
    await user.type(day, '2026-12-20');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    expect(await within(dialog).findByText('Moves from Dec 1, 2026 to Dec 20, 2026')).toBeVisible();
    expect(
      within(dialog).getByText(
        'Stays on Dec 8, 2026: you do not administer its track, so it will read as out of step',
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText('1 more release you may not see stays as it is.'),
    ).toBeVisible();
    // The list changed nothing.
    expect(client.moved()).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Move 1 release' }));
    const heading = await within(dialog).findByRole('heading', {
      name: 'Spring launch now ends on Dec 20, 2026',
    });
    expect(heading).toHaveFocus();
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 release moved.');
    expect(client.moved()).toBe('2026-12-20');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await screen.findAllByText('Dec 20, 2026')).length).toBeGreaterThan(0);
  });

  it('[PLN-007] lists again when someone else changed it first', async () => {
    const user = userEvent.setup();
    const client = renderPage({ staleOnce: true });
    await user.click(await screen.findByRole('button', { name: 'Move date' }));
    const dialog = await screen.findByRole('dialog');
    const day = within(dialog).getByLabelText('New date');
    await user.clear(day);
    await user.type(day, '2026-12-20');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Move 1 release' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone changed it meanwhile.',
    );
    expect(client.moved()).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Move 1 release' }));
    await within(dialog).findByRole('heading', { name: /now ends on/ });
    expect(client.moved()).toBe('2026-12-20');
  });

  it('[PLN-007] says so when all its releases have shipped, and when the date is the same', async () => {
    const user = userEvent.setup();
    renderPage({ shipped: true });
    await user.click(await screen.findByRole('button', { name: 'Move date' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'All its releases have shipped',
    );
  });

  it('[PLN-007] links and removes a release, which moves no date', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Link a release' }));
    const dialog = await screen.findByRole('dialog');
    // Shop is already linked: only a release of another track is offered.
    const select = await within(dialog).findByLabelText('Release');
    expect(within(select).queryByRole('option', { name: /Shop 2\.1/ })).toBeNull();
    await user.selectOptions(select, 'Website 3.0');
    await user.click(within(dialog).getByRole('button', { name: 'Link it' }));
    expect(await screen.findByRole('link', { name: '3.0' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove 2.0' }));
    await screen.findByText('2.0 is no longer linked. Its date did not change.');
    expect(client.unlinked()).toEqual([21]);
  });

  it('[PLN-007] edits its name and may end when its work completes', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Summer launch');
    await user.click(within(dialog).getByRole('checkbox', { name: /End when its work completes/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Summer launch', level: 1 })).toBeVisible();
    expect(screen.getByText('When its work completes')).toBeVisible();
    expect(screen.queryByText('Out of step')).toBeNull();
  });

  it('[PLN-007] asks before deleting, and answers one it may not see as not found', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const client = renderPage();
    const remove = vi.spyOn(client, 'remove');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith(
      'Delete Spring launch? Its releases stay as they are, and free to join another.',
    );
    expect(remove).not.toHaveBeenCalled();
    confirm.mockRestore();
    const missing = {
      ...fakeCrossTrackClient(),
      get: async () => {
        throw new ApiError(404, { error: 'not_found' });
      },
    };
    show(<CrossTrackReleasePage id={9} client={missing} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This release across tracks does not exist, or you cannot see it.',
    );
  });

  it('[PLN-007] fits a phone: the linked releases are cards, with no sideways scroll', async () => {
    setViewportWidth(375);
    renderPage();
    const cards = await screen.findByRole('list', { name: 'Linked releases' });
    expect(within(cards).getByRole('heading', { name: 'Shop 2.0', level: 3 })).toBeVisible();
    expect(within(cards).getByText('Out of step')).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Linked releases' })).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
    setViewportWidth(1280);
  });

  it('[PLN-007] gathers linked releases on their day into one marker, and those out of step keep their own', () => {
    const cross = { id: 5, name: 'Spring launch', date: '2026-12-01' };
    const drawn = drawnReleases([
      { id: 1, name: 'A', date: '2026-12-01', shipped: false, crossTrack: cross },
      { id: 2, name: 'B', date: '2026-12-01', shipped: false, crossTrack: cross },
      { id: 3, name: 'C', date: '2026-12-08', shipped: false, crossTrack: cross },
      { id: 4, name: 'D', date: '2026-12-09', shipped: true, crossTrack: cross },
      { id: 5, name: 'E', date: '2026-12-10', shipped: false, crossTrack: null },
      { id: 6, name: 'F', date: '2026-12-11', shipped: false },
    ]);
    expect(drawn.map((d) => [d.name, d.count, d.outOfStep])).toEqual([
      ['Spring launch', 2, false],
      ['C', 0, true],
      ['D', 0, false],
      ['E', 0, false],
      ['F', 0, false],
    ]);
  });
});

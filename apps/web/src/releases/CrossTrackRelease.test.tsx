import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { drawnReleases } from '../timeline/markers';
import { CrossTrackReleasePage } from './CrossTrackReleasePage';
import { CrossTrackReleasesPage } from './CrossTrackReleasesPage';
import { crossTrackClient } from './crossTrackClient';
import { type FakeCrossTrackOptions, fakeCrossTrackClient } from './crossTrackFixtures';
import { MoveDateDialog } from './MoveDateDialog';
import { NewCrossTrackDialog } from './NewCrossTrackDialog';

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    // A fixed end asks for a day; this one ends when its work completes, so no day is asked for.
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

  it('[PLN-007] sends nothing for a fixed end with no day, and says each candidate’s day as people read it', async () => {
    const user = userEvent.setup();
    const client = fakeCrossTrackClient({ empty: true });
    const create = vi.spyOn(client, 'create');
    show(<CrossTrackReleasesPage client={client} />);
    await user.click(await screen.findByRole('button', { name: 'New release across tracks' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Launch');
    await user.click(await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ }));
    expect(within(dialog).getByText(/Due on Dec 15, 2026/)).toBeVisible();
    const day = within(dialog).getByLabelText('The day');
    await user.click(within(dialog).getByRole('button', { name: 'Make it' }));
    expect(day).toBeInvalid();
    expect(create).not.toHaveBeenCalled();
  });

  it('[PLN-007] finds what lies past where the list stops, by asking the server, and keeps what was ticked', async () => {
    const user = userEvent.setup();
    const client = fakeCrossTrackClient({ empty: true, stopsShort: true });
    const candidates = vi.spyOn(client, 'candidates');
    const create = vi.spyOn(client, 'create');
    show(<NewCrossTrackDialog client={client} onMade={() => {}} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Launch');
    await user.click(within(dialog).getByRole('radio', { name: 'When its work completes' }));
    await user.click(await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ }));
    expect(within(dialog).getByText(/The list stops at 500/)).toBeVisible();
    expect(within(dialog).queryByRole('checkbox', { name: /Website 3\.0/ })).toBeNull();
    await user.type(within(dialog).getByLabelText('Filter releases'), 'website');
    await user.click(await within(dialog).findByRole('checkbox', { name: /Website 3\.0/ }));
    expect(candidates).toHaveBeenLastCalledWith('website');
    expect(within(dialog).getByRole('checkbox', { name: /Shop 2\.1/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Make it' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Launch',
        endRule: 'work_complete',
        releaseIds: [31, 32],
      }),
    );
  });

  it('[PLN-007] says so when a filter matches nothing', async () => {
    const user = userEvent.setup();
    show(
      <NewCrossTrackDialog
        client={fakeCrossTrackClient({ empty: true })}
        onMade={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('checkbox', { name: /Shop 2\.1/ });
    await user.type(within(dialog).getByLabelText('Filter releases'), 'no such release');
    expect(within(dialog).getByText('No release matches this filter.')).toBeVisible();
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

  it('[PLN-007] offers no move once all its releases have shipped, and says so if they ship meanwhile', async () => {
    const user = userEvent.setup();
    const client = renderPage({ shipped: true });
    await screen.findByRole('heading', { name: 'Spring launch', level: 1 });
    expect(screen.queryByRole('button', { name: 'Move date' })).toBeNull();
    show(
      <MoveDateDialog
        id={5}
        name="Spring launch"
        date="2026-12-01"
        client={client}
        onMoved={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'All its releases have shipped',
    );
  });

  it('[PLN-007] says nothing changes on the day it already has, when no release can come back to it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Move date' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      'It already ends on this date, so nothing changes.',
    );
    expect(within(dialog).queryByText(/^Moves from/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Move/ })).toBeNull();
  });

  it('[PLN-007] brings back what is out of step on the day it already has', async () => {
    const user = userEvent.setup();
    const client = renderPage({ administersAll: true });
    await user.click(await screen.findByRole('button', { name: 'Move date' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      'It already ends on this date: 1 release out of step comes back to it.',
    );
    expect(within(dialog).getByText('Moves from Dec 8, 2026 to Dec 1, 2026')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Move 1 release' }));
    await within(dialog).findByRole('heading', { name: /now ends on Dec 1, 2026/ });
    expect(client.moved()).toBe('2026-12-01');
  });

  it('[PLN-007] keeps the line that is read out in the page from the start, apart from the long list', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Move date' }));
    const dialog = await screen.findByRole('dialog');
    const status = within(dialog).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    const day = within(dialog).getByLabelText('New date');
    await user.clear(day);
    await user.type(day, '2026-12-20');
    await user.click(within(dialog).getByRole('button', { name: 'Show what changes' }));
    await within(dialog).findByRole('button', { name: 'Move 1 release' });
    expect(within(dialog).getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('1 release would move.');
    expect(within(status).queryByRole('list')).toBeNull();
    expect(within(dialog).getByRole('list')).toBeVisible();
  });

  it('[PLN-007] says when no answer came, and leaves every control working', async () => {
    const user = userEvent.setup();
    const answers = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              from: '2026-12-01',
              to: '2026-12-20',
              version: 3,
              changed: false,
              hidden: { releases: 0 },
              lines: [
                {
                  id: 21,
                  name: '2.0',
                  track: { id: 1, key: 'SHOP', name: 'Shop' },
                  from: '2026-12-01',
                  to: '2026-12-20',
                  outcome: 'moves',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => (answers.shift() as () => Promise<Response>)()),
    );
    show(
      <MoveDateDialog
        id={5}
        name="Spring launch"
        date="2026-12-01"
        client={crossTrackClient}
        onMoved={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const list = within(dialog).getByRole('button', { name: 'Show what changes' });
    await user.click(list);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server could not be reached',
    );
    expect(list).toBeEnabled();
    await user.click(list);
    const move = await within(dialog).findByRole('button', { name: 'Move 1 release' });
    await user.click(move);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('may not have happened');
    expect(move).toBeEnabled();
  });

  it('[PLN-007] answers no answer as a refusal on every change, and never rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const refused = { ok: false, code: 'unreachable' };
    expect(await crossTrackClient.update(5, { version: 1 })).toEqual(refused);
    expect(await crossTrackClient.remove(5)).toEqual(refused);
    expect(await crossTrackClient.link(5, 1)).toEqual(refused);
    expect(await crossTrackClient.unlink(5, 1)).toEqual(refused);
    expect(
      await crossTrackClient.create({ name: 'x', endRule: 'work_complete', releaseIds: [1] }),
    ).toEqual(refused);
  });

  it('[PLN-007] keeps Link a release to someone with a track to link from', async () => {
    renderPage({ mayManage: false, mayLink: false });
    await screen.findByRole('heading', { name: 'Spring launch', level: 1 });
    expect(screen.queryByRole('button', { name: 'Link a release' })).toBeNull();
  });

  it('[PLN-007] tells an outage from nothing to link', async () => {
    const user = userEvent.setup();
    const client = fakeCrossTrackClient();
    client.candidates = async () => {
      throw new Error('down');
    };
    show(<CrossTrackReleasePage id={5} client={client} />);
    await user.click(await screen.findByRole('button', { name: 'Link a release' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The releases you may link could not be read.',
    );
    expect(within(dialog).queryByText('No release to link')).toBeNull();
  });

  it('[PLN-007] links a release past where the list stops, by a word', async () => {
    const user = userEvent.setup();
    renderPage({ stopsShort: true });
    await user.click(await screen.findByRole('button', { name: 'Link a release' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/The list stops at 500/)).toBeVisible();
    await user.type(within(dialog).getByLabelText('Filter releases'), 'website');
    const select = await within(dialog).findByLabelText('Release');
    await user.selectOptions(select, 'Website 3.0');
    await user.click(within(dialog).getByRole('button', { name: 'Link it' }));
    expect(await screen.findByRole('link', { name: '3.0' })).toBeVisible();
  });

  it('[PLN-007] shows the page of Show more failing in words, and the button stays', async () => {
    const user = userEvent.setup();
    const base = fakeCrossTrackClient();
    const asks = vi.fn();
    const client = {
      ...base,
      list: async (state: 'upcoming' | 'shipped', cursor?: string) => {
        asks(cursor);
        if (cursor) throw new Error('down');
        const page = await base.list(state);
        return { ...page, next: state === 'upcoming' ? '2026-12-01_5' : null };
      },
    };
    show(<CrossTrackReleasesPage client={client} />);
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The next ones could not be read. Try again.',
    );
    expect(screen.getByRole('button', { name: 'Show more' })).toBeVisible();
    expect(asks).toHaveBeenCalledWith('2026-12-01_5');
  });

  it('[PLN-007] reads itself again when an edit finds someone changed it first, so saving again works', async () => {
    const user = userEvent.setup();
    const client = fakeCrossTrackClient({ staleEditOnce: true });
    const update = vi.spyOn(client, 'update');
    show(<CrossTrackReleasePage id={5} client={client} />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Summer launch');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'What you typed is still here: check it and save again.',
    );
    expect(name).toHaveValue('Summer launch');
    expect(update).toHaveBeenLastCalledWith(5, expect.objectContaining({ version: 3 }));
    // The page read itself again behind the dialog.
    await screen.findByText('Someone else wrote this.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Summer launch', level: 1 })).toBeVisible();
    expect(update).toHaveBeenLastCalledWith(5, expect.objectContaining({ version: 4 }));
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
    // Its button has gone: focus waits on the heading above, not on the page's body.
    expect(screen.getByRole('heading', { name: 'Linked releases', level: 2 })).toHaveFocus();
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

  it('[PLN-007] draws its linked releases as cards on a phone', async () => {
    setViewportWidth(375);
    renderPage();
    const cards = await screen.findByRole('list', { name: 'Linked releases' });
    expect(within(cards).getByRole('heading', { name: 'Shop 2.0', level: 3 })).toBeVisible();
    expect(within(cards).getByText('Out of step')).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Linked releases' })).toBeNull();
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

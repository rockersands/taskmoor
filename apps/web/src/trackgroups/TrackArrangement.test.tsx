import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import type { TrackGroup } from './client';
import {
  type FakeTrackGroupClient,
  fakeTrackGroupClient,
  GROUP_TRACKS,
  ownGroup,
  sharedGroup,
} from './fixtures';
import { ShareGroupDialog } from './ShareGroupDialog';
import { TrackArrangement } from './TrackArrangement';

const ARRANGED: TrackGroup[] = [
  ownGroup(1, 'Launch', [1, 3]),
  ownGroup(2, 'Back office', [4, 5], { minimized: true }),
  sharedGroup(3, 'Grace’s picks', [2]),
];

function Page({ client, start }: { client: FakeTrackGroupClient; start: TrackGroup[] }) {
  const [groups, setGroups] = useState(start);
  return (
    <TrackArrangement tracks={GROUP_TRACKS} groups={groups} client={client} onGroups={setGroups} />
  );
}

function open(start: TrackGroup[] = ARRANGED, client = fakeTrackGroupClient({ groups: start })) {
  render(
    <I18nProvider locale="en">
      <Page client={client} start={start} />
    </I18nProvider>,
  );
  return client;
}

const region = (name: string) => screen.getByRole('region', { name });
const linksIn = (name: string) =>
  within(region(name))
    .queryAllByRole('link')
    .map((link) => link.querySelector('.tracks-item-key')?.textContent);
const looseKeys = () =>
  within(region('Tracks in no group'))
    .queryAllByRole('link')
    .map((link) => link.querySelector('.tracks-item-key')?.textContent);
const handle = (name: string) => screen.getByRole('button', { name: `Move ${name}` });

/**
 * A drag with pointer events, as a mouse or a finger makes it: down on a handle, moves over
 * the page, up over the target. jsdom lays nothing out, so what is under the pointer is the
 * element the test names.
 */
function dragTo(from: HTMLElement, to: Element, pointerType: 'mouse' | 'touch' = 'mouse') {
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(to);
  const point = { pointerId: 7, pointerType, isPrimary: true };
  fireEvent.pointerDown(from, { ...point, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { ...point, clientX: 40, clientY: 60 });
  fireEvent.pointerMove(window, { ...point, clientX: 80, clientY: 120 });
  fireEvent.pointerUp(window, { ...point, clientX: 80, clientY: 120 });
  under.mockRestore();
}

const card = (key: string) =>
  screen
    .getAllByRole('listitem')
    .find((li) => li.querySelector('.tracks-item-key')?.textContent === key) as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Tracks page in groups (CORE-034)', () => {
  it('[CORE-034] shows open groups with their tracks, minimized ones as a count, then the rest', () => {
    open();
    expect(linksIn('Launch')).toEqual(['SHOP', 'PAY']);
    const office = region('Back office');
    expect(within(office).getByText('2 tracks')).toBeVisible();
    expect(within(office).queryByRole('link')).toBeNull();
    expect(office.querySelectorAll('.track-group-square')).toHaveLength(2);
    expect(within(office).getByRole('button', { name: 'Open Back office' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(region('Grace’s picks')).getByText('Shared by Grace Hopper')).toBeVisible();
    // A track in a group shared with the person may also sit among theirs.
    expect(looseKeys()).toEqual(['WEB', 'DATA']);
  });

  it('[CORE-034] a mouse drag of a track onto another makes a group of the two, named first', async () => {
    const user = userEvent.setup();
    const client = open([]);
    dragTo(handle('Web'), card('DATA'));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    expect(within(dialog).getByLabelText('Group name')).toHaveFocus();
    await user.type(within(dialog).getByLabelText('Group name'), 'Insights');
    await user.click(within(dialog).getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(linksIn('Insights')).toEqual(['DATA', 'WEB']));
    expect(client.calls).toContainEqual({ method: 'create', args: ['Insights', [6, 2]] });
    expect(screen.getByRole('status')).toHaveTextContent('Insights made.');
    expect(screen.getByRole('button', { name: 'Move or change the group Insights' })).toHaveFocus();
  });

  it('[CORE-034] a touch drag puts a track into a group, at the place it is dropped', async () => {
    const client = open();
    dragTo(handle('Web'), card('PAY'), 'touch');
    await waitFor(() => expect(linksIn('Launch')).toEqual(['SHOP', 'WEB', 'PAY']));
    expect(client.calls).toContainEqual({ method: 'place', args: [1, 2, 1] });
    dragTo(handle('Data'), screen.getByRole('region', { name: 'Back office' }), 'touch');
    await waitFor(() =>
      expect(client.calls).toContainEqual({ method: 'place', args: [2, 6, undefined] }),
    );
  });

  it('[CORE-034] a drag among the tracks in no group takes a track out of its group', async () => {
    const client = open();
    dragTo(handle('Shop'), region('Tracks in no group'));
    await waitFor(() => expect(looseKeys()).toEqual(['SHOP', 'WEB', 'DATA']));
    expect(client.calls).toContainEqual({ method: 'takeOut', args: [1, 1] });
  });

  it('[CORE-034] a group dragged onto another takes its place', async () => {
    const client = open();
    dragTo(
      screen.getByRole('button', { name: 'Move or change the group Launch' }),
      region('Grace’s picks'),
    );
    await waitFor(() =>
      expect(client.calls).toContainEqual({ method: 'order', args: [[2, 3, 1]] }),
    );
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Back office',
      'Grace’s picks',
      'Launch',
      'Tracks in no group',
    ]);
  });

  it('[CORE-034] a press without moving opens the menu; a drag does not', async () => {
    const user = userEvent.setup();
    open();
    await user.click(handle('Web'));
    expect(screen.getByRole('menu', { name: 'Move Web' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(handle('Web')).toHaveFocus();
  });

  it('[CORE-034] every drag has a keyboard path: Alt and the arrows, and the grip’s menu', async () => {
    const user = userEvent.setup();
    const client = open();
    handle('Shop').focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(linksIn('Launch')).toEqual(['PAY', 'SHOP']));
    expect(handle('Shop')).toHaveFocus();
    expect(client.calls).toContainEqual({ method: 'place', args: [1, 1, 1] });
    // Into another group: it is minimized, so focus goes to that group's grip.
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: 'Move Shop' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Move earlier',
      'Move to Back office',
      'Take out of Launch',
      'New group with this track',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Move to Back office' }));
    await waitFor(() => expect(within(region('Back office')).getByText('3 tracks')).toBeVisible());
    expect(
      screen.getByRole('button', { name: 'Move or change the group Back office' }),
    ).toHaveFocus();
    // A track in no group starts a new one from its menu.
    await user.click(handle('Web'));
    await user.click(screen.getByRole('menuitem', { name: 'New group with this track' }));
    const dialog = screen.getByRole('dialog', { name: 'New group' });
    await user.type(within(dialog).getByLabelText('Group name'), 'Web work{Enter}');
    await waitFor(() => expect(linksIn('Web work')).toEqual(['WEB']));
    // Out again by its menu.
    await user.click(handle('Web'));
    await user.click(screen.getByRole('menuitem', { name: 'Take out of Web work' }));
    await waitFor(() => expect(looseKeys()).toContain('WEB'));
    expect(handle('Web')).toHaveFocus();
  });

  it('[CORE-034] groups move by keyboard, and open and minimize', async () => {
    const user = userEvent.setup();
    const client = open();
    screen.getByRole('button', { name: 'Move or change the group Back office' }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() =>
      expect(client.calls).toContainEqual({ method: 'order', args: [[2, 1, 3]] }),
    );
    expect(
      screen.getByRole('button', { name: 'Move or change the group Back office' }),
    ).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Open Back office' }));
    await waitFor(() => expect(linksIn('Back office')).toEqual(['OPS', 'HR']));
    expect(client.calls).toContainEqual({ method: 'update', args: [2, { minimized: false }] });
    await user.click(screen.getByRole('button', { name: 'Minimize Launch' }));
    await waitFor(() => expect(linksIn('Launch')).toEqual([]));
  });

  it('[CORE-034] renames a group and deletes it after asking', async () => {
    const user = userEvent.setup();
    const client = open();
    await user.click(screen.getByRole('button', { name: 'Move or change the group Launch' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename group' });
    const field = within(dialog).getByLabelText('Group name');
    expect(field).toHaveValue('Launch');
    await user.clear(field);
    await user.type(field, 'Go live');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(region('Go live')).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Move or change the group Go live' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete group' }));
    const ask = screen.getByRole('dialog', { name: 'Delete Go live?' });
    await user.click(within(ask).getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Go live' })).toBeNull());
    expect(looseKeys()).toEqual(['SHOP', 'WEB', 'PAY', 'DATA']);
    expect(client.calls.map((c) => c.method)).toEqual(['update', 'remove']);
  });

  it('[CORE-034] a group shared with the person is theirs to order and minimize, nothing more', async () => {
    const user = userEvent.setup();
    open();
    const picks = region('Grace’s picks');
    expect(within(picks).queryByRole('button', { name: /^Move Web/ })).toBeNull();
    await user.click(
      within(picks).getByRole('button', { name: 'Move or change the group Grace’s picks' }),
    );
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Move earlier',
    ]);
  });

  it('[CORE-034] says when a change did not go through, and keeps the page as it was', async () => {
    const user = userEvent.setup();
    const client = fakeTrackGroupClient({
      groups: ARRANGED,
      failNext: new ApiError(409, { error: 'last_track_admin', trackIds: [1] }),
    });
    open(ARRANGED, client);
    await user.click(screen.getByRole('button', { name: 'Move or change the group Launch' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete group' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete group' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/nobody to run it/);
    expect(region('Launch')).toBeVisible();
  });

  it('[CORE-034] on a phone the hint says how to reach every move, and the menus hold them', async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByText(/Alt with the arrow keys/)).toBeVisible();
    act(() => setViewportWidth(375));
    expect(screen.getByText(/tap the grip for a menu of every move/)).toBeVisible();
    await user.click(handle('Payments'));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Move earlier',
      'Move to Back office',
      'Take out of Launch',
      'New group with this track',
    ]);
  });
});

describe('sharing a group (IAM-034)', () => {
  function share(mode: 'share' | 'setOn', client = fakeTrackGroupClient(), onChanged = vi.fn()) {
    render(
      <I18nProvider locale="en">
        <ShareGroupDialog
          mode={mode}
          group={ARRANGED[0] as TrackGroup}
          client={client}
          onClose={() => {}}
          onChanged={onChanged}
        />
      </I18nProvider>,
    );
    return { client, onChanged };
  }

  it('[IAM-034] shares with a person and a role, saying where it gave it', async () => {
    const user = userEvent.setup();
    const { client, onChanged } = share(
      'share',
      fakeTrackGroupClient({ outcome: { tracks: 3, given: 1, alreadyHeld: 1, notGivable: 1 } }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Share Launch' });
    expect(await within(dialog).findByText('Grace Hopper: Members, on 2 tracks')).toBeVisible();
    expect(within(dialog).getByText('deactivated')).toBeVisible();
    const role = within(dialog).getByLabelText('Role on its tracks');
    expect(role).toHaveValue('');
    expect(
      within(role)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'No role: the group only',
      'Administrators, on 1 of 2 tracks',
      'Members, on 2 of 2 tracks',
    ]);
    expect(within(dialog).getByRole('button', { name: 'Share' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Find a person by name'), 'Ana');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Ana Pérez' }));
    expect(within(dialog).getByText('For Ana Pérez')).toBeVisible();
    await user.selectOptions(role, 'Members, on 2 of 2 tracks');
    await user.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      'Shared with Ana Pérez. Members given on 1 of 3 tracks; they already had it on 1, and you may not give it on 1.',
    );
    expect(client.calls).toContainEqual({ method: 'share', args: [1, 9, 2] });
    expect(onChanged).toHaveBeenCalled();
    expect(within(dialog).getByText('Ana Pérez: Members, on 1 track')).toBeVisible();
    // Taking it back.
    await user.click(within(dialog).getByRole('button', { name: 'Take back from Ana Pérez' }));
    expect(await within(dialog).findByText('Taken back from Ana Pérez.')).toBeVisible();
    expect(client.calls).toContainEqual({ method: 'unshare', args: [1, 9] });
  });

  it('[IAM-034] sets a copy on someone, with no role unless one is chosen', async () => {
    const user = userEvent.setup();
    const { client } = share('setOn');
    const dialog = screen.getByRole('dialog', { name: 'Set Launch on someone' });
    await user.type(within(dialog).getByLabelText('Find a person by name'), 'Alan');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Alan Turing' }));
    await user.click(within(dialog).getByRole('button', { name: 'Set on them' }));
    expect(
      await within(dialog).findByText('Alan Turing now has a copy of their own.'),
    ).toBeVisible();
    expect(client.calls).toContainEqual({ method: 'setOn', args: [1, 8, null] });
  });

  it('[IAM-034] explains the server’s refusals in plain words', async () => {
    const user = userEvent.setup();
    for (const [code, words] of [
      ['already_shared', /already shared with them/],
      ['person_inactive', /deactivated, so nothing was given/],
      ['last_track_admin', /nobody to run it/],
    ] as const) {
      const client = fakeTrackGroupClient({ failNext: new ApiError(409, { error: code }) });
      const { unmount } = render(
        <I18nProvider locale="en">
          <ShareGroupDialog
            mode="share"
            group={ARRANGED[0] as TrackGroup}
            client={client}
            onClose={() => {}}
            onChanged={() => {}}
          />
        </I18nProvider>,
      );
      const dialog = screen.getByRole('dialog');
      await user.type(within(dialog).getByLabelText('Find a person by name'), 'Gr');
      await user.click(await within(dialog).findByRole('button', { name: 'Choose Grace Hopper' }));
      await user.click(within(dialog).getByRole('button', { name: 'Share' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(words);
      unmount();
    }
  });

  it('[IAM-034] works on a phone', async () => {
    const user = userEvent.setup();
    act(() => setViewportWidth(360));
    share('share');
    const dialog = screen.getByRole('dialog', { name: 'Share Launch' });
    await user.type(within(dialog).getByLabelText('Find a person by name'), 'Gr');
    expect(
      await within(dialog).findByRole('button', { name: 'Choose Grace Hopper' }),
    ).toBeVisible();
  });
});

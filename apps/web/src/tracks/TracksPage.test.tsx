import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { ConfigurationClient, Track } from '../configuration/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Session, SessionProvider, type SessionUser } from '../session/SessionProvider';
import type { TrackGroupClient } from '../trackgroups/client';
import { fakeTrackGroupClient, ownGroup, sharedGroup } from '../trackgroups/fixtures';
import { fakeTrackClient } from './fixtures';
import { TracksPage } from './TracksPage';
import { newTrackModes } from './trackAccess';

const person = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1,
  name: 'Kalo',
  email: 'kalo@example.com',
  isSiteAdmin: false,
  isConfigAdmin: false,
  mayCreateLocalTracks: false,
  timeZone: null,
  locale: null,
  ...over,
});
const signedIn = (over: Partial<SessionUser> = {}): Session => ({
  status: 'signed-in',
  user: person(over),
});

const SHOP = {
  id: 3,
  key: 'SHOP',
  name: 'Shop',
  mode: 'shared',
  archived: false,
} as unknown as Track;

function fakeCreator(create: ConfigurationClient['createTrack'] = vi.fn()) {
  return {
    tracks: vi.fn(async () => [SHOP]),
    createTrack: create,
  } as unknown as ConfigurationClient;
}

function open(
  session: Session,
  options: {
    creator?: ConfigurationClient;
    empty?: boolean;
    groups?: TrackGroupClient;
    list?: () => Promise<{ id: number; key: string; name: string; owner: null }[]>;
  } = {},
) {
  const client = fakeTrackClient();
  if (options.empty) client.list = async () => [];
  if (options.list) client.list = options.list;
  render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <TracksPage
          client={client}
          creator={options.creator ?? fakeCreator()}
          groups={options.groups ?? fakeTrackGroupClient()}
        />
      </SessionProvider>
    </I18nProvider>,
  );
}

const newTrack = () => screen.findByRole('button', { name: 'New track' });

afterEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
});

describe('who may make a track, as the server has it (CORE-001)', () => {
  it('[CORE-001] shared for administrators, local for the permission, nothing otherwise', () => {
    expect(newTrackModes(null)).toEqual([]);
    expect(newTrackModes(person())).toEqual([]);
    expect(newTrackModes(person({ isSiteAdmin: true }))).toEqual(['shared']);
    expect(newTrackModes(person({ isSiteAdmin: true, mayCreateLocalTracks: true }))).toEqual([
      'shared',
      'local',
    ]);
    expect(newTrackModes(person({ isConfigAdmin: true }))).toEqual(['shared']);
    expect(newTrackModes(person({ mayCreateLocalTracks: true }))).toEqual(['local']);
  });
});

describe('New track on the directory (CORE-001)', () => {
  it('[CORE-001] shows no button to someone with no right to make a track', async () => {
    open(signedIn());
    expect(await screen.findByRole('link', { name: /Shop/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New track' })).toBeNull();
  });

  it('[CORE-001] shows no button to someone not signed in', async () => {
    open({ status: 'anonymous' });
    expect(await screen.findByRole('link', { name: /Shop/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New track' })).toBeNull();
  });

  it('[CORE-001] opens the form in a dialog, makes the track and lands in it', async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => ({ track: { ...SHOP, id: 9, key: 'PAY', name: 'Payments' } }));
    open(signedIn({ isSiteAdmin: true, mayCreateLocalTracks: true }), {
      creator: fakeCreator(create),
    });
    await user.click(await newTrack());
    const dialog = within(screen.getByRole('dialog', { name: 'New track' }));
    expect(dialog.getByLabelText('Key')).toHaveFocus();
    await user.type(dialog.getByLabelText('Key'), 'pay');
    await user.type(dialog.getByLabelText('Track name'), 'Payments');
    await user.selectOptions(
      dialog.getByRole('combobox', { name: 'Start from' }),
      'Kanban: a board of continuous flow',
    );
    await user.click(dialog.getByRole('button', { name: 'Create track' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tracks/PAY'));
    expect(create).toHaveBeenCalledWith({
      key: 'PAY',
      name: 'Payments',
      mode: 'shared',
      template: 'kanban',
    });
  });

  it('[CORE-001] offers only what the person may make: their own configuration, and no copy', async () => {
    const user = userEvent.setup();
    const creator = fakeCreator();
    open(signedIn({ mayCreateLocalTracks: true }), { creator });
    await user.click(await newTrack());
    const dialog = within(screen.getByRole('dialog', { name: 'New track' }));
    expect(
      within(dialog.getByRole('combobox', { name: 'Configuration' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Its own configuration']);
    expect(creator.tracks).not.toHaveBeenCalled();
    expect(dialog.queryByRole('option', { name: 'Shop (SHOP)' })).toBeNull();
  });

  it('[CORE-001] offers a shared track to copy to those who may make a shared one', async () => {
    const user = userEvent.setup();
    open(signedIn({ isConfigAdmin: true }));
    await user.click(await newTrack());
    const dialog = within(screen.getByRole('dialog', { name: 'New track' }));
    expect(await dialog.findByRole('option', { name: 'Shop (SHOP)' })).toBeInTheDocument();
    expect(
      within(dialog.getByRole('combobox', { name: 'Configuration' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Shared configuration']);
  });

  it('[CORE-001] says why the server refused, and stays open', async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => {
      throw new ApiError(409, { error: 'key_taken' });
    });
    open(signedIn({ isSiteAdmin: true }), { creator: fakeCreator(create) });
    await user.click(await newTrack());
    const dialog = within(screen.getByRole('dialog', { name: 'New track' }));
    await user.type(dialog.getByLabelText('Key'), 'SHOP');
    await user.type(dialog.getByLabelText('Track name'), 'Again');
    await user.click(dialog.getByRole('button', { name: 'Create track' }));
    expect(await dialog.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'New track' })).toBeVisible();
  });

  it('[CORE-001] closes on Escape and on Cancel, giving focus back to the button', async () => {
    const user = userEvent.setup();
    open(signedIn({ isSiteAdmin: true }));
    const button = await newTrack();
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.click(
      within(screen.getByRole('dialog', { name: 'New track' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[CORE-001] has a Close at its title, as the create dialog has, over a veil (AD-10)', async () => {
    const user = userEvent.setup();
    open(signedIn({ isSiteAdmin: true }));
    const button = await newTrack();
    await user.click(button);
    const dialog = screen.getByRole('dialog', { name: 'New track' });
    // Drawn at the end of the page's body, so no glass of the page holds it or its veil.
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: 'Close without making a track' }).parentElement).toBe(
      document.body,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('[CORE-001] opens from its address, as the palette leads to it, and leaves it on closing', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/tracks?new';
    open(signedIn({ isSiteAdmin: true }));
    expect(await screen.findByRole('dialog', { name: 'New track' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(window.location.hash).toBe('#/tracks'));
  });

  it('[CORE-001] ignores that address for someone with no right', async () => {
    window.location.hash = '#/tracks?new';
    open(signedIn());
    expect(await screen.findByRole('link', { name: /Shop/ })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[CORE-001] an empty directory explains and offers it to someone who may', async () => {
    const user = userEvent.setup();
    open(signedIn({ mayCreateLocalTracks: true }), { empty: true });
    expect(await screen.findByText('No tracks yet')).toBeVisible();
    expect(screen.getByText(/Make the first one/)).toBeVisible();
    const offered = screen.getAllByRole('button', { name: 'New track' });
    expect(offered).toHaveLength(2);
    await user.click(offered[1] as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'New track' })).toBeVisible();
  });

  it('[CORE-001] an empty directory only explains to someone who may not', async () => {
    open(signedIn(), { empty: true });
    expect(await screen.findByText('No tracks yet')).toBeVisible();
    expect(screen.getByText(/Administrators make them/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New track' })).toBeNull();
  });
});

describe('the directory in the person’s groups (CORE-034)', () => {
  it('[CORE-034] shows the person’s groups, and a search lists the matches plainly', async () => {
    const user = userEvent.setup();
    open(signedIn(), {
      groups: fakeTrackGroupClient({ groups: [ownGroup(1, 'Launch', [1])] }),
    });
    const launch = await screen.findByRole('region', { name: 'Launch' });
    expect(within(launch).getByRole('link', { name: /Shop/ })).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Tracks in no group' })).getByRole('link', {
        name: /Web/,
      }),
    ).toBeVisible();
    await user.type(screen.getByLabelText('Find a track'), 'sh');
    expect(screen.queryByRole('region', { name: 'Launch' })).toBeNull();
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['SHOPShop']);
  });

  it('[IAM-034] leaving a shared group reads the tracks again: those it opened go', async () => {
    const user = userEvent.setup();
    const web = { id: 2, key: 'WEB', name: 'Web', owner: null };
    const shop = { id: 1, key: 'SHOP', name: 'Shop', owner: null };
    // The share opened Web; once left, the server lists only Shop.
    const list = vi.fn().mockResolvedValueOnce([shop, web]).mockResolvedValue([shop]);
    open(signedIn(), {
      list,
      groups: fakeTrackGroupClient({ groups: [sharedGroup(5, 'Grace’s picks', [2])] }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Move or change the group Grace’s picks' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Leave group…' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Leave Grace’s picks?' })).getByRole('button', {
        name: 'Leave group',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('link', { name: /Web/ })).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /Shop/ })).toBeVisible();
  });

  /** Leaves a shared group from the keyboard: its handle's menu, then the dialog's button. */
  async function leaveByKeyboard(user: ReturnType<typeof userEvent.setup>, name: string) {
    const grip = await screen.findByRole('button', { name: `Move or change the group ${name}` });
    grip.focus();
    await user.keyboard('{Enter}');
    const leave = screen.getByRole('menuitem', { name: 'Leave group…' });
    leave.focus();
    await user.keyboard('{Enter}');
    within(screen.getByRole('dialog', { name: `Leave ${name}?` }))
      .getByRole('button', { name: 'Leave group' })
      .focus();
    await user.keyboard('{Enter}');
  }

  it('[IAM-034] leaving puts focus on a track still there, never on one the share opened', async () => {
    const user = userEvent.setup();
    const web = { id: 2, key: 'WEB', name: 'Web', owner: null };
    const shop = { id: 1, key: 'SHOP', name: 'Shop', owner: null };
    // Web comes first and only the share opened it; once left, the server lists only Shop.
    const list = vi.fn().mockResolvedValueOnce([web, shop]).mockResolvedValue([shop]);
    open(signedIn(), {
      list,
      groups: fakeTrackGroupClient({ groups: [sharedGroup(5, 'Grace’s picks', [2])] }),
    });
    await leaveByKeyboard(user, 'Grace’s picks');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Shop' })).toHaveFocus());
    expect(screen.queryByRole('link', { name: /Web/ })).toBeNull();
    // The groups' own status says it, a moment later.
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((status) => status.textContent)).toContain(
        'You left Grace’s picks.',
      ),
    );
  });

  it('[IAM-034] leaving the group that opened every track says so, and the empty page takes focus', async () => {
    const user = userEvent.setup();
    const web = { id: 2, key: 'WEB', name: 'Web', owner: null };
    const list = vi.fn().mockResolvedValueOnce([web]).mockResolvedValue([]);
    open(signedIn(), {
      list,
      groups: fakeTrackGroupClient({ groups: [sharedGroup(5, 'Grace’s picks', [2])] }),
    });
    await leaveByKeyboard(user, 'Grace’s picks');
    await waitFor(() => expect(screen.getByText('No tracks yet')).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('You left Grace’s picks.');
    expect(screen.queryByRole('region', { name: 'Grace’s picks' })).toBeNull();
  });

  it('[CORE-034] without its groups the page still lists every track, and says so', async () => {
    const groups = fakeTrackGroupClient({ layoutFails: true });
    open(signedIn(), { groups });
    expect(await screen.findByRole('alert')).toHaveTextContent('Your groups could not be loaded');
    expect(screen.getByRole('link', { name: /Shop/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /Web/ })).toBeVisible();
  });
});

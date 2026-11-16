import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider, type SessionUser } from '../session/SessionProvider';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { parseAddresses } from './client';
import {
  type FakeTrackPeopleOptions,
  fakeInvitationClient,
  fakeTrackPeopleClient,
  LINK,
  WAITING,
} from './fixtures';
import { InvitationPage } from './InvitationPage';
import { ManagedTracksPage } from './ManagedTracksPage';
import { TrackPeoplePage } from './TrackPeoplePage';

/** An action's answer as drawn on the page, not the page's status line that also says it. */
const seen = (text: string) =>
  screen.findByText(text, { ignore: 'script, style, .visually-hidden' });

function renderPeople(
  options: FakeTrackPeopleOptions = {},
  session = MEMBER,
  locale: Locale = 'en',
) {
  const client = fakeTrackPeopleClient(options);
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <TrackPeoplePage trackId={3} client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('a track manager without site administration (IAM-030)', () => {
  it('[IAM-030] lists the tracks a person runs, each leading to its page', async () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <ManagedTracksPage client={fakeTrackPeopleClient()} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    const link = await screen.findByRole('link', { name: 'Manage track SHOP' });
    expect(link.getAttribute('href')).toContain('#/manage/tracks/3');
    expect(screen.getByRole('link', { name: 'Manage track OPS' })).toBeInTheDocument();
  });

  it('[IAM-030] shows who holds which role, and gives and takes roles', async () => {
    const user = userEvent.setup();
    const client = renderPeople();
    expect(await screen.findByText('Kalo Reyes: Administrators')).toBeInTheDocument();
    expect(screen.getByText('Group Support: Members')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Bo Lind from Members' }));
    expect(await seen('Bo Lind no longer holds Members.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Role'), 'Viewers');
    await user.type(screen.getByLabelText('Find a person by name'), 'ana');
    await user.click(await screen.findByRole('button', { name: 'Give Viewers to Ana Duarte' }));
    expect(await seen('Ana Duarte now holds Viewers.')).toBeInTheDocument();
    expect(client.calls.filter((c) => c.action === 'setRole').map((c) => c.args)).toEqual([
      [3, 8, 'users', 2, false],
      [3, 9, 'users', 4, true],
    ]);
  });

  it('[IAM-028] without the appointing permission that role can be neither given nor taken', async () => {
    renderPeople({ appointLocked: true });
    await screen.findByText('Kalo Reyes: Administrators');
    expect(
      screen.getByText(
        'You cannot give or remove the role that runs this track. A site administrator can.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Kalo Reyes from Administrators' })).toBe(
      null,
    );
    expect(screen.getByRole('option', { name: 'Administrators' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Bo Lind from Members' })).toBeEnabled();
  });

  it('[IAM-028] says when the last person who runs the track cannot be removed', async () => {
    const user = userEvent.setup();
    renderPeople();
    await user.click(
      await screen.findByRole('button', { name: 'Remove Kalo Reyes from Administrators' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This is the last person who runs the track',
    );
    expect(screen.getByText('Kalo Reyes: Administrators')).toBeInTheDocument();
  });

  it('[IAM-030] a person who does not run the track is told so', async () => {
    const client = fakeTrackPeopleClient();
    client.track = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <TrackPeoplePage trackId={3} client={client} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    expect(
      await screen.findByText('Only people who run this track can manage it.'),
    ).toBeInTheDocument();
  });

  it('[IAM-030] a track with its own configuration leads to its own layout and configuration sets (T-163a)', async () => {
    const show = (trackId: number) =>
      render(
        <I18nProvider locale="en">
          <SessionProvider session={MEMBER}>
            <main>
              <TrackPeoplePage trackId={trackId} client={fakeTrackPeopleClient()} />
            </main>
          </SessionProvider>
        </I18nProvider>,
      );
    show(4);
    const own = await screen.findByRole('region', { name: 'Its own configuration' });
    expect(own).toHaveTextContent('OPS has its own configuration, and you can change it here:');
    expect(
      within(own).getByRole('link', { name: 'Layout sets: where fields appear on its forms' }),
    ).toHaveAttribute('href', '#/manage/tracks/4/layouts');
    expect(
      within(own).getByRole('link', {
        name: 'Configuration sets: its ticket types and field rules',
      }),
    ).toHaveAttribute('href', '#/manage/tracks/4/configuration-sets');
    cleanup();
    // A track in shared mode owns none: its sets are the administrators'.
    show(3);
    expect(await screen.findByText('Kalo Reyes: Administrators')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Its own configuration' })).toBeNull();
  });
});

describe('the invite dialog (IAM-027)', () => {
  it('[IAM-027] a pasted list goes out with the chosen role; the role that runs the track is not the default', async () => {
    const user = userEvent.setup();
    const client = renderPeople();
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite people to SHOP' });
    expect(within(dialog).getByRole('heading', { name: 'Invite people to SHOP' })).toHaveFocus();
    expect(within(dialog).getByLabelText('Role')).toHaveDisplayValue('Members');
    await user.click(within(dialog).getByLabelText('Email addresses'));
    await user.paste('Ana <ana@example.com>; bo@example.com\nfriend@personal.example');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Viewers');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
    expect(await within(dialog).findByText('ana@example.com: invited.')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/friend@personal\.example: invited\. .*two-factor/),
    ).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'invite')?.args[1]).toEqual({
      addresses: ['ana@example.com', 'bo@example.com', 'friend@personal.example'],
      userIds: [],
      roleId: 9,
      delivery: 'email',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(await screen.findByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite people' })).toHaveFocus();
  });

  it('[IAM-027] a person found by name is added without typing an address', async () => {
    const user = userEvent.setup();
    const client = renderPeople();
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Find a person by name'), 'ana');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose Ana Duarte' }));
    await user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
    expect(await within(dialog).findByText('Ana Duarte: now holds the role.')).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'invite')?.args[1]).toMatchObject({
      addresses: [],
      userIds: [4],
    });
  });

  it('[IAM-027] without a mail server it says so plainly and makes links to copy', async () => {
    const user = userEvent.setup();
    renderPeople({ emailAvailable: false });
    await screen.findByRole('button', { name: 'Invite people' });
    expect(screen.getByText(/Email is not set up on this site/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Email is not set up on this site/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).toBe(null);
    await user.type(within(dialog).getByLabelText('Email addresses'), 'nia2@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Make links' }));
    const link = await within(dialog).findByRole('textbox', { name: 'Link for nia2@example.com' });
    expect((link as HTMLInputElement).value).toContain('/#/invite?token=');
  });

  it('[IAM-027] the role that runs the track is not offered without the permission', async () => {
    const user = userEvent.setup();
    renderPeople({ appointLocked: true });
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    const roles = within(screen.getByRole('dialog')).getByLabelText('Role');
    expect(within(roles).queryByRole('option', { name: 'Administrators' })).toBe(null);
  });

  it('[IAM-027] inviting off: no button, and a site administrator is pointed at the permission', async () => {
    renderPeople({ canInvite: false, invitingGiven: false });
    expect(await screen.findByText(/Inviting is off for this track/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite people' })).toBe(null);
    expect(screen.queryByRole('link', { name: 'Open Permissions' })).toBe(null);
  });

  it('[IAM-027] a site administrator can invite and is told how to let others', async () => {
    renderPeople({ invitingGiven: false }, ADMIN);
    expect(await screen.findByRole('link', { name: 'Open Permissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeEnabled();
  });

  it('[IAM-027] invitations waiting can be sent again, relinked and withdrawn', async () => {
    const user = userEvent.setup();
    // A site administrator, who may copy links where the site sends email too (T-053).
    const client = renderPeople({ canCopyLinks: true }, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Send again to nia@example.com' }));
    expect(await seen('The invitation to nia@example.com went out again.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Make a new link for nia@example.com' }));
    const fresh = await screen.findByRole('textbox', { name: 'Link for nia@example.com' });
    expect((fresh as HTMLInputElement).value).toContain('again-21');
    await user.click(
      screen.getByRole('button', { name: 'Withdraw the invitation to nia@example.com' }),
    );
    expect(await screen.findByText('No invitations are waiting.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual(['resend', 'resend', 'revoke']);
  });

  it('[IAM-027] where the site sends email a manager sends invitations by email, with no link to copy (T-053)', async () => {
    const user = userEvent.setup();
    const client = renderPeople({ emailAvailable: true, canCopyLinks: false });
    await screen.findByRole('button', { name: 'Send again to nia@example.com' });
    const note =
      'Your invitations go by email: on a site that sends email, only site administrators copy links.';
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a new link for nia@example.com' })).toBe(
      null,
    );
    await user.click(screen.getByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(note)).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).toBe(null);
    await user.type(within(dialog).getByLabelText('Email addresses'), 'nia3@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
    expect(await within(dialog).findByText('nia3@example.com: invited.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: /Link for/ })).toBe(null);
    expect(client.calls.find((c) => c.action === 'invite')?.args[1]).toMatchObject({
      delivery: 'email',
    });
  });

  it('[IAM-027] a site administrator still chooses between email and a link where email works (T-053)', async () => {
    const user = userEvent.setup();
    renderPeople({ emailAvailable: true, canCopyLinks: true }, ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('radio', { name: 'I copy a link and pass it on' }),
    ).toBeVisible();
    expect(screen.queryByText(/only site administrators copy links/)).toBe(null);
    expect(
      screen.getByRole('button', { name: 'Make a new link for nia@example.com' }),
    ).toBeInTheDocument();
  });

  it('[IAM-027] a refused link is explained in the same words (T-053)', async () => {
    const user = userEvent.setup();
    // The page still offered links when the site's mail came on meanwhile: the server refuses.
    const client = fakeTrackPeopleClient({ emailAvailable: true, canCopyLinks: false });
    const offered = {
      ...client,
      invitations: async (trackId: number) => ({
        ...(await client.invitations(trackId)),
        canCopyLinks: true,
      }),
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <main>
            <TrackPeoplePage trackId={3} client={offered} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Make a new link for nia@example.com' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your invitations go by email: on a site that sends email, only site administrators copy links.',
    );
  });

  it('[IAM-027] reads pasted lists', () => {
    expect(parseAddresses(' a@x.example, b@x.example;c@x.example\nd@x.example ')).toEqual([
      'a@x.example',
      'b@x.example',
      'c@x.example',
      'd@x.example',
    ]);
    expect(parseAddresses('Ana Duarte <ana@x.example>, "Bo" <bo@x.example>')).toEqual([
      'ana@x.example',
      'bo@x.example',
    ]);
    expect(parseAddresses('notanaddress a@x.example a@x.example')).toEqual([
      'notanaddress',
      'a@x.example',
    ]);
  });
});

describe('checklist notices, a choice of whoever runs the track (NTF-015)', () => {
  const NAME = 'Tell followers when a checklist changes';
  const noticeCalls = (client: ReturnType<typeof renderPeople>) =>
    client.calls.filter((c) => c.action === 'setChecklistNotices').map((c) => c.args);

  it('[NTF-015] is off to begin with, and saves at once when ticked or unticked, saying so', async () => {
    const user = userEvent.setup();
    const client = renderPeople();
    const box = await screen.findByRole('checkbox', { name: NAME });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(
      'The followers of a ticket hear of changes to its checklists and their items, in their inbox and by email as each of them chooses. Nobody hears of their own changes, and changes close together come as one notice.',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Notices to followers' })).toBeVisible();
    await user.click(box);
    expect(
      await seen('Followers of tickets in SHOP now hear when a checklist changes.'),
    ).toBeInTheDocument();
    expect(box).toBeChecked();
    // From the keyboard too: Space on the focused box turns it off again.
    box.focus();
    await user.keyboard(' ');
    expect(
      await seen('Followers of tickets in SHOP no longer hear when a checklist changes.'),
    ).toBeInTheDocument();
    expect(box).not.toBeChecked();
    expect(box).toHaveFocus();
    expect(noticeCalls(client)).toEqual([
      [3, true],
      [3, false],
    ]);
  });

  it('[NTF-015] shows what the track has stored', async () => {
    renderPeople({ checklistNotices: true });
    expect(await screen.findByRole('checkbox', { name: NAME })).toBeChecked();
  });

  it('[NTF-015] goes back and says why when the server refuses', async () => {
    const user = userEvent.setup();
    const client = renderPeople({ refuseNotices: true });
    const box = await screen.findByRole('checkbox', { name: NAME });
    await user.click(box);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The track is archived, so its settings cannot change.',
    );
    expect(box).not.toBeChecked();
    expect(box).toHaveFocus();
    expect(noticeCalls(client)).toEqual([[3, true]]);
  });

  it('[NTF-015] says what happened right under the box, before its hint (T-248)', async () => {
    const user = userEvent.setup();
    renderPeople({ refuseNotices: true });
    const box = await screen.findByRole('checkbox', { name: NAME });
    await user.click(box);
    const card = screen.getByRole('region', { name: 'Notices to followers' });
    const alert = await within(card).findByRole('alert');
    expect(alert).toHaveTextContent('The track is archived, so its settings cannot change.');
    // Between the box and its hint, and the only alert on the page.
    const hint = within(card).getByText(/^The followers of a ticket hear/);
    expect(box.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    cleanup();

    // What went through shows there too, and the page's status line tells a screen reader.
    renderPeople();
    const saving = await screen.findByRole('checkbox', { name: NAME });
    await user.click(saving);
    const said = await seen('Followers of tickets in SHOP now hear when a checklist changes.');
    const savedHint = screen.getByText(/^The followers of a ticket hear/);
    expect(saving.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(said.compareDocumentPosition(savedHint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Followers of tickets in SHOP now hear when a checklist changes.',
      ),
    );
  });

  it('[NTF-015] speaks Spanish', async () => {
    const user = userEvent.setup();
    renderPeople({}, MEMBER, 'es');
    const box = await screen.findByRole('checkbox', {
      name: 'Avisar a quienes siguen un ticket cuando cambia una lista de comprobación',
    });
    await user.click(box);
    expect(
      await seen(
        'Quienes siguen tickets de SHOP ahora se enteran cuando cambia una lista de comprobación.',
      ),
    ).toBeInTheDocument();
    // How it looks at a phone's width is a browser's to say: the story
    // `ChecklistNoticesAtPhoneWidth` measures it in a browser, as on a touch screen.
  });
});

describe('what an action did shows beside the row pressed (T-248)', () => {
  /** The rows of a list, by what each says. */
  const rowsOf = (list: HTMLElement) =>
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
  const holdersList = () =>
    within(screen.getByRole('region', { name: 'Who holds which role' })).getAllByRole('list')[0];
  /** The page's one status line, which tells a screen reader what went through. */
  const announced = (text: string) =>
    waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text));

  it('[IAM-030] a role taken away is said in its row’s place, between the rows around it, and told to a screen reader', async () => {
    const user = userEvent.setup();
    renderPeople();
    await user.click(await screen.findByRole('button', { name: 'Remove Bo Lind from Members' }));
    await seen('Bo Lind no longer holds Members.');
    expect(rowsOf(holdersList() as HTMLElement)).toEqual([
      'Kalo Reyes: AdministratorsRemove',
      'Bo Lind no longer holds Members.',
      'Group Support: MembersRemove',
    ]);
    await announced('Bo Lind no longer holds Members.');
  });

  it('[IAM-028] a refusal shows in the row pressed, and only there', async () => {
    const user = userEvent.setup();
    renderPeople();
    await user.click(
      await screen.findByRole('button', { name: 'Remove Kalo Reyes from Administrators' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This is the last person who runs the track');
    const row = alert.closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Kalo Reyes: Administrators');
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    // Nothing went through, so nothing is told as done.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('[IAM-030] a role given is said where the person found was, under the search, until the next search', async () => {
    const user = userEvent.setup();
    renderPeople();
    await screen.findByText('Kalo Reyes: Administrators');
    await user.selectOptions(screen.getByLabelText('Role'), 'Viewers');
    const search = screen.getByLabelText('Find a person by name');
    await user.type(search, 'ana');
    await user.click(await screen.findByRole('button', { name: 'Give Viewers to Ana Duarte' }));
    const said = await seen('Ana Duarte now holds Viewers.');
    expect(search.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(said.closest('li')).not.toBeNull();
    // Not in the list of who holds which role above, where the person now appears.
    expect(holdersList()).not.toContainElement(said);
    await announced('Ana Duarte now holds Viewers.');
    // A new search starts a new list.
    await user.type(search, 'bo');
    await waitFor(() => expect(said).not.toBeInTheDocument());
  });

  it('[IAM-027] each invitation’s answer, and its new link, show in its own row', async () => {
    const user = userEvent.setup();
    const second = { ...WAITING, id: 22, email: 'oli@example.com' };
    // A site administrator, who may copy links where the site sends email (T-053).
    renderPeople({ invitations: [WAITING, second], canCopyLinks: true }, ADMIN);
    const waiting = await screen.findByRole('region', { name: 'Invitations waiting' });
    const rowOf = (email: string) =>
      within(waiting)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.startsWith(email)) as HTMLElement;

    await user.click(screen.getByRole('button', { name: 'Send again to oli@example.com' }));
    expect(
      await within(rowOf('oli@example.com')).findByText(
        'The invitation to oli@example.com went out again.',
      ),
    ).toBeVisible();
    expect(rowOf('nia@example.com')).not.toHaveTextContent('went out again');
    await announced('The invitation to oli@example.com went out again.');

    await user.click(screen.getByRole('button', { name: 'Make a new link for oli@example.com' }));
    const link = await within(rowOf('oli@example.com')).findByRole('textbox', {
      name: 'Link for oli@example.com',
    });
    expect((link as HTMLInputElement).value).toContain('again-22');

    // Withdrawn, the first row gives its place to what was done; the second keeps its own.
    await user.click(
      screen.getByRole('button', { name: 'Withdraw the invitation to nia@example.com' }),
    );
    await seen('The invitation to nia@example.com was withdrawn.');
    expect(rowsOf(within(waiting).getByRole('list'))[0]).toBe(
      'The invitation to nia@example.com was withdrawn.',
    );
    expect(within(waiting).getAllByRole('listitem')).toHaveLength(2);
  });
});

/** A manager who may create tracks, and so give that permission (IAM-033). */
const CREATOR = {
  status: 'signed-in' as const,
  user: {
    ...(MEMBER as Extract<typeof MEMBER, { status: 'signed-in' }>).user,
    mayCreateLocalTracks: true,
  },
};

describe('the permission to create tracks with the role that runs the track (IAM-033)', () => {
  const box = () => screen.getByRole('checkbox', { name: 'Also let them create tracks' });
  const setRoleCalls = (client: ReturnType<typeof renderPeople>) =>
    client.calls.filter((c) => c.action === 'setRole').map((c) => c.args);

  it('[IAM-033] the box is ticked when the role runs the track, and goes with the role', async () => {
    const user = userEvent.setup();
    const client = renderPeople({}, CREATOR);
    await screen.findByText('Kalo Reyes: Administrators');
    expect(screen.getByLabelText('Role')).toHaveDisplayValue('Administrators');
    expect(box()).toBeChecked();
    expect(box()).toHaveAccessibleDescription(/permission for the whole site/);
    // The permission goes with the role (T-087b, S3-TR-1): the hint never says it stays.
    expect(box()).toHaveAccessibleDescription(/It goes with the role: once they run no track/);
    expect(box()).not.toHaveAccessibleDescription(/does not remove it/);
    await user.type(screen.getByLabelText('Find a person by name'), 'ana');
    await user.click(
      await screen.findByRole('button', { name: 'Give Administrators to Ana Duarte' }),
    );
    expect(
      await seen('Ana Duarte now holds Administrators and can create tracks.'),
    ).toBeInTheDocument();
    expect(setRoleCalls(client)).toEqual([[3, 7, 'users', 4, true, { createTracks: true }]]);
  });

  it('[IAM-033] unticked, the role goes alone', async () => {
    const user = userEvent.setup();
    const client = renderPeople({}, CREATOR);
    await screen.findByText('Kalo Reyes: Administrators');
    await user.click(box());
    expect(box()).not.toBeChecked();
    await user.type(screen.getByLabelText('Find a person by name'), 'ana');
    await user.click(
      await screen.findByRole('button', { name: 'Give Administrators to Ana Duarte' }),
    );
    expect(await seen('Ana Duarte now holds Administrators.')).toBeInTheDocument();
    expect(setRoleCalls(client)).toEqual([[3, 7, 'users', 4, true]]);
  });

  it('[IAM-033] no box with a role that does not run the track, nor for someone who cannot give it', async () => {
    const user = userEvent.setup();
    renderPeople({}, CREATOR);
    await screen.findByText('Kalo Reyes: Administrators');
    await user.selectOptions(screen.getByLabelText('Role'), 'Members');
    expect(screen.queryByRole('checkbox', { name: 'Also let them create tracks' })).toBe(null);
    cleanup();
    renderPeople({}, MEMBER);
    await screen.findByText('Kalo Reyes: Administrators');
    expect(screen.getByLabelText('Role')).toHaveDisplayValue('Administrators');
    expect(screen.queryByRole('checkbox', { name: 'Also let them create tracks' })).toBe(null);
  });

  it('[IAM-033] a site administrator is offered the box', async () => {
    renderPeople({}, ADMIN);
    await screen.findByText('Kalo Reyes: Administrators');
    expect(box()).toBeChecked();
  });

  it('[IAM-033] says so when the server refuses the permission', async () => {
    const user = userEvent.setup();
    renderPeople({ refuseCreateTracks: true }, CREATOR);
    await screen.findByText('Kalo Reyes: Administrators');
    await user.type(screen.getByLabelText('Find a person by name'), 'ana');
    await user.click(
      await screen.findByRole('button', { name: 'Give Administrators to Ana Duarte' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only site administrators and people who can create tracks themselves can give that permission.',
    );
  });

  it('[IAM-033] the invite dialog offers the box with the role that runs the track', async () => {
    const user = userEvent.setup();
    const client = renderPeople({}, CREATOR);
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).toBe(null);
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Administrators');
    const ticked = within(dialog).getByRole('checkbox', { name: 'Also let them create tracks' });
    expect(ticked).toBeChecked();
    await user.type(within(dialog).getByLabelText('Email addresses'), 'lead@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
    expect(await within(dialog).findByText('lead@example.com: invited.')).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'invite')?.args[1]).toEqual({
      addresses: ['lead@example.com'],
      userIds: [],
      roleId: 7,
      delivery: 'email',
      createTracks: true,
    });
  });

  it('[IAM-033] the invite dialog sends no permission once unticked, or to someone who cannot give it', async () => {
    const user = userEvent.setup();
    const client = renderPeople({}, CREATOR);
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'Administrators');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Also let them create tracks' }));
    await user.type(within(dialog).getByLabelText('Email addresses'), 'lead@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitations' }));
    await within(dialog).findByText('lead@example.com: invited.');
    expect(client.calls.find((c) => c.action === 'invite')?.args[1]).not.toHaveProperty(
      'createTracks',
    );
    cleanup();
    renderPeople({}, MEMBER);
    await user.click(await screen.findByRole('button', { name: 'Invite people' }));
    await user.selectOptions(
      within(screen.getByRole('dialog')).getByLabelText('Role'),
      'Administrators',
    );
    expect(within(screen.getByRole('dialog')).queryByRole('checkbox')).toBe(null);
  });
});

describe('an invitation whose address a provider serves (IAM-032)', () => {
  it('[IAM-032] the page opens at signing in, with the provider on offer, and returns to the link', async () => {
    window.location.hash = '#/invite?token=tok';
    const user = userEvent.setup();
    const went: string[] = [];
    const google = { id: 8, name: 'Google' };
    const ssoClient = {
      providers: async () => [google],
      discover: async () => ({ provider: google, password: true }),
      go: (url: string) => {
        went.push(url);
      },
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={fakeInvitationClient()} ssoClient={ssoClient} />
        </SessionProvider>
      </I18nProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(screen.getByRole('radio', { name: 'Sign in' })).toBeChecked();
    await user.click(button);
    expect(went).toHaveLength(1);
    expect(went[0]).toContain('/api/v1/auth/oidc/8/start?returnTo=');
    expect(decodeURIComponent(went[0] as string)).toContain('#/invite');
    expect(decodeURIComponent(went[0] as string)).not.toContain('tok');

    // Choosing a password stays possible, and stays chosen.
    await user.click(screen.getByRole('radio', { name: 'Choose a name and a password' }));
    expect(screen.getByRole('form', { name: 'Choose a name and a password' })).toBeVisible();
  });

  it('[IAM-032] with no provider for the address the page stays at choosing a password', async () => {
    window.location.hash = '#/invite?token=tok';
    const asked: string[] = [];
    const ssoClient = {
      providers: async () => [],
      discover: async (email: string) => {
        asked.push(email);
        return { provider: null, password: true };
      },
      go: () => {},
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={fakeInvitationClient()} ssoClient={ssoClient} />
        </SessionProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(screen.getByRole('radio', { name: 'Choose a name and a password' })).toBeChecked();
  });
});

describe('the page an invitation leads to (IAM-027, IAM-029)', () => {
  const signedIn = (email: string): SessionUser => ({
    id: 9,
    email,
    name: 'Nia',
    isSiteAdmin: false,
    timeZone: null,
    locale: null,
    appearance: 'system',
  });

  beforeEach(() => {
    window.sessionStorage.clear();
    window.location.hash = '#/invite?token=the-token';
  });
  afterEach(() => {
    window.location.hash = '';
    vi.unstubAllGlobals();
  });

  it('[IAM-027] leaves out the role when the invitation names none (AD-7)', async () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={fakeInvitationClient({ roleName: '' })} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText('Kalo Reyes invited you, at nia@example.com.')).toBeVisible();
    expect(screen.queryByText(/as ,/)).toBeNull();
  });

  it('[IAM-027] a link with no invitation says so, without the intro, with the frame’s way out (D24)', () => {
    window.location.hash = '#/invite';
    window.sessionStorage.clear();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={fakeInvitationClient()} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(screen.getByText(/This address has no invitation in it/)).toBeVisible();
    expect(screen.getByText(/ask a site administrator for a new one/)).toBeVisible();
    expect(screen.queryByText(/You were invited to a track/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '#/sign-in',
    );
  });

  it('[IAM-027] a new person chooses a name and a password, goes through sign-in and lands in the track', async () => {
    const user = userEvent.setup();
    const calls = stubBackend({
      'POST /session': () =>
        jsonResponse(200, { status: 'signed_in', user: signedIn('nia@example.com') }),
    });
    const client = fakeInvitationClient();
    const onJoined = vi.fn();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={client} onJoined={onJoined} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Your invitation to SHOP · Shop' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Kalo Reyes invited you as Members, at nia@example.com.'),
    ).toBeVisible();
    await user.type(screen.getByLabelText('Your name'), 'Nia Okafor');
    await user.type(screen.getByLabelText('New password'), 'another otter lantern');
    await user.type(screen.getByLabelText('Confirm new password'), 'another otter lantern');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('SHOP'));
    expect(client.calls[0]).toEqual({ action: 'redeem', args: ['the-token', 'Nia Okafor', 21] });
    expect(calls.find((c) => c.path === '/session')?.body).toEqual({
      email: 'nia@example.com',
      password: 'another otter lantern',
    });
  });

  it('[IAM-029] an address outside the organization is warned, and sign-in asks for the second factor before anything else', async () => {
    const user = userEvent.setup();
    stubBackend({
      'POST /session': () =>
        jsonResponse(200, { status: 'enrollment_required', challenge: 'a-challenge' }),
      'POST /session/enroll/totp': () =>
        jsonResponse(200, { secret: 'ABC', uri: 'otpauth://totp/x?secret=ABC' }),
    });
    const onJoined = vi.fn();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage
            client={fakeInvitationClient({ secondFactorRequired: true })}
            onJoined={onJoined}
          />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText(/This site asks for two-factor/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your name'), 'Friend');
    await user.type(screen.getByLabelText('New password'), 'another otter lantern');
    await user.type(screen.getByLabelText('Confirm new password'), 'another otter lantern');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('form', { name: /authenticator/i })).toBeInTheDocument();
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('[IAM-027] both ways in are offered to everyone: the page says nothing about accounts', async () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={fakeInvitationClient()} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(
      await screen.findByRole('radio', { name: 'Choose a name and a password' }),
    ).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Sign in' })).not.toBeChecked();
  });

  it('[IAM-029] someone with an account signs in, with their provider if the site has one, and joins', async () => {
    window.location.hash = '#/invite?token=the-token&account=1';
    const user = userEvent.setup();
    stubBackend({
      'GET /auth/providers': () => jsonResponse(200, { providers: [{ id: 1, name: 'Staff' }] }),
      'POST /auth/discover': () => jsonResponse(200, { provider: null, password: true }),
      'POST /session': () =>
        jsonResponse(200, { status: 'signed_in', user: signedIn('nia@example.com') }),
    });
    const client = fakeInvitationClient();
    const onJoined = vi.fn();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={client} onJoined={onJoined} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByRole('radio', { name: 'Sign in' })).toBeChecked();
    expect(screen.getByLabelText('Email')).toHaveValue('nia@example.com');
    expect(await screen.findByRole('button', { name: /Staff/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'ladder violet harbour');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('SHOP'));
    expect(client.calls).toEqual([{ action: 'accept', args: ['the-token'] }]);
  });

  it('[IAM-029] a single sign-on starts without the token in its address, and the page finds it again', async () => {
    window.location.hash = '#/invite?token=the-token&account=1';
    const user = userEvent.setup();
    const go = vi.fn();
    const ssoClient = {
      providers: async () => [{ id: 1, name: 'Staff' }],
      discover: async () => ({ provider: null, password: true }),
      go,
    };
    const client = fakeInvitationClient();
    const inspect = vi.spyOn(client, 'inspect');
    const { unmount } = render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={client} ssoClient={ssoClient} />
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Staff/ }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(String(go.mock.calls[0]?.[0])).not.toContain('the-token');
    expect(decodeURIComponent(String(go.mock.calls[0]?.[0]))).toContain('#/invite');
    unmount();

    // Back from the provider, signed in, at the bare route.
    window.location.hash = '#/invite';
    const onJoined = vi.fn();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'signed-in', user: signedIn(LINK.email) }}>
          <InvitationPage client={client} onJoined={onJoined} />
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Join SHOP' }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('SHOP'));
    expect(inspect).toHaveBeenLastCalledWith('the-token');
    expect(window.sessionStorage.getItem('taskmoor.invitation')).toBe(null);
  });

  it('[IAM-027] someone already signed in joins with one click', async () => {
    const user = userEvent.setup();
    const client = fakeInvitationClient();
    const onJoined = vi.fn();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'signed-in', user: signedIn(LINK.email) }}>
          <InvitationPage client={client} onJoined={onJoined} />
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Join SHOP' }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('SHOP'));
  });

  it('[IAM-027] someone signed in as another person is told to sign out first', async () => {
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'signed-in', user: signedIn('other@example.com') }}>
          <InvitationPage client={fakeInvitationClient()} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText(/This invitation is for nia@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join SHOP' })).toBe(null);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('[IAM-027] a used, withdrawn or expired link says so before anyone types', async () => {
    const client = fakeInvitationClient();
    client.inspect = async () => {
      throw new ApiError(404, { error: 'invalid_link' });
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={client} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText(/This invitation can no longer be used/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).toBe(null);
  });

  it('[IAM-029] where the domain must use its provider, the page moves to signing in', async () => {
    const user = userEvent.setup();
    stubBackend({
      'GET /auth/providers': () => jsonResponse(200, { providers: [] }),
      'POST /auth/discover': () => jsonResponse(200, { provider: null, password: true }),
    });
    const client = fakeInvitationClient();
    client.redeem = async () => {
      throw new ApiError(403, {
        error: 'sso_required',
        provider: { id: 1, name: 'Staff', protocol: 'oidc' },
      });
    };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={{ status: 'anonymous' }}>
          <InvitationPage client={client} />
        </SessionProvider>
      </I18nProvider>,
    );
    await user.type(await screen.findByLabelText('Your name'), 'Someone');
    await user.type(screen.getByLabelText('New password'), 'another otter lantern');
    await user.type(screen.getByLabelText('Confirm new password'), 'another otter lantern');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/signs in through its organisation/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toBeChecked();
  });
});

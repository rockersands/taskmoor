import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { fakeSignInSso } from '../sso/fixtures';
import { asOnATouchScreen, onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { ChecklistNoticesBox } from './ChecklistNoticesBox';
import { CreateTracksBox } from './CreateTracksBox';
import { fakeInvitationClient, fakeTrackPeopleClient, ROLES, WAITING } from './fixtures';
import { InvitationPage } from './InvitationPage';
import { InviteDialog } from './InviteDialog';
import { ManagedTracksPage } from './ManagedTracksPage';
import { TrackPeoplePage } from './TrackPeoplePage';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

/** The pages of a track manager and of an invited person (IAM-027, IAM-030). */
const meta = {
  title: 'Track people/TrackPeoplePage',
  component: TrackPeoplePage,
  args: { trackId: 3, client: fakeTrackPeopleClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TrackPeoplePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Manager: Story = {};

/**
 * On a phone the link inside a note keeps the line's height, its 44 px press area reaching above
 * and below it: the line holding 'Open Permissions' sat about 31 px under the line above, against
 * 18 px elsewhere (T-226).
 */
export const InlineLinkOnAPhone: Story = {
  args: { client: fakeTrackPeopleClient({ invitingGiven: false }) },
  decorators: [
    atPhoneWidth,
    (Story) => (
      <SessionProvider session={ADMIN}>
        <Story />
      </SessionProvider>
    ),
  ],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: 'Open Permissions' });
    // The link is as tall as its text (it was 44 px, which pushed its line down).
    const fontSize = Number.parseFloat(getComputedStyle(link).fontSize);
    await expect(link.getBoundingClientRect().height).toBeLessThanOrEqual(fontSize * 1.6);
    const press = getComputedStyle(link, '::after');
    await expect(press.position).toBe('absolute');
    await expect(Number.parseFloat(press.height)).toBeGreaterThanOrEqual(44 - 0.5);
    await fitsPhoneWidth(canvas);
  },
};

/** A track with its own configuration: its page leads to its own sets (T-163a). */
export const OwnConfiguration: Story = {
  args: { trackId: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Layout sets: where fields appear on its forms' }),
    ).toBeVisible();
  },
};

/** The same on a phone. */
export const OwnConfigurationPhone: Story = {
  ...OwnConfiguration,
  globals: { viewport: { value: 'mobile1' } },
};

export const AppointingRemoved: Story = {
  args: { client: fakeTrackPeopleClient({ appointLocked: true }) },
};

export const InvitingOff: Story = {
  args: { client: fakeTrackPeopleClient({ canInvite: false, invitingGiven: false }) },
};

export const NoMailServer: Story = {
  args: { client: fakeTrackPeopleClient({ emailAvailable: false }) },
};

/**
 * Where the site sends email a manager's invitations go by email (T-053): no New link, and one
 * line saying why.
 */
export const ManagerWhereEmailWorks: Story = {
  args: { client: fakeTrackPeopleClient({ emailAvailable: true, canCopyLinks: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Your invitations go by email: on a site that sends email/),
    ).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /Make a new link/ })).toBeNull();
  },
};

/** A site administrator on the same site may still copy a link (T-053). */
export const LinksForASiteAdministrator: Story = {
  args: { client: fakeTrackPeopleClient({ emailAvailable: true, canCopyLinks: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: 'Make a new link for nia@example.com' }),
    ).toBeVisible();
  },
};

/** The manager's dialog: email only, with the line that says why. */
export const DialogEmailOnly: StoryObj<typeof InviteDialog> = {
  render: () => (
    <InviteDialog
      track={{ id: 3, key: 'SHOP' }}
      roles={ROLES}
      emailAvailable
      canCopyLinks={false}
      client={fakeTrackPeopleClient()}
      onClose={() => {}}
      onSent={() => {}}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('radio')).toBeNull();
    await expect(canvas.getByText(/only site administrators copy links/)).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'mobile1' } },
};

export const DialogOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Invite people' }));
    await expect(canvas.getByRole('dialog')).toBeInTheDocument();
  },
};

export const DialogAlone: StoryObj<typeof InviteDialog> = {
  render: () => (
    <InviteDialog
      track={{ id: 3, key: 'SHOP' }}
      roles={ROLES}
      emailAvailable={false}
      client={fakeTrackPeopleClient({ emailAvailable: false })}
      onClose={() => {}}
      onSent={() => {}}
    />
  ),
};

/** A manager who may create tracks, and so give that permission with the role (IAM-033). */
const creator = {
  status: 'signed-in' as const,
  user: {
    ...(MEMBER as Extract<typeof MEMBER, { status: 'signed-in' }>).user,
    mayCreateLocalTracks: true,
  },
};
const asCreator: Story['decorators'] = [
  (Story) => (
    <SessionProvider session={creator}>
      <Story />
    </SessionProvider>
  ),
];

/** The role that runs the track is chosen: the box is ticked under it. */
export const GivingCreateTracks: Story = {
  decorators: asCreator,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('checkbox', { name: 'Also let them create tracks' }),
    ).toBeChecked();
  },
};

export const GivingCreateTracksPhone: Story = {
  decorators: asCreator,
  globals: { viewport: { value: 'mobile1' } },
};

export const DialogWithCreateTracks: StoryObj<typeof InviteDialog> = {
  render: () => (
    <InviteDialog
      track={{ id: 3, key: 'SHOP' }}
      roles={ROLES}
      emailAvailable
      mayGrantCreateTracks
      client={fakeTrackPeopleClient()}
      onClose={() => {}}
      onSent={() => {}}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText('Role'), 'Administrators');
    await expect(
      canvas.getByRole('checkbox', { name: 'Also let them create tracks' }),
    ).toBeChecked();
  },
};

export const CreateTracksBoxAlone: StoryObj<typeof CreateTracksBox> = {
  render: () => <CreateTracksBox checked onChange={() => {}} />,
};

/** Whoever runs the track has its followers told of checklist changes (NTF-015), said under the box. */
export const ChecklistNotices: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('checkbox', {
      name: 'Tell followers when a checklist changes',
    });
    await expect(box).not.toBeChecked();
    await userEvent.click(box);
    const card = canvas.getByRole('region', { name: 'Notices to followers' });
    await expect(
      await within(card).findByText(
        'Followers of tickets in SHOP now hear when a checklist changes.',
      ),
    ).toBeVisible();
    await expect(box).toBeChecked();
  },
};

/** The server refuses: the box goes back, and why is said under it, where the person is (T-232). */
export const ChecklistNoticesRefused: Story = {
  args: { client: fakeTrackPeopleClient({ refuseNotices: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('checkbox', {
      name: 'Tell followers when a checklist changes',
    });
    await userEvent.click(box);
    const card = canvas.getByRole('region', { name: 'Notices to followers' });
    const alert = await within(card).findByRole('alert');
    await expect(alert).toHaveTextContent('The track is archived, so its settings cannot change.');
    await expect(alert).toBeVisible();
    await expect(box).not.toBeChecked();
    // Below the box, not far above it: the two are on screen together.
    const gap = alert.getBoundingClientRect().top - box.getBoundingClientRect().bottom;
    await expect(gap).toBeGreaterThanOrEqual(0);
    await expect(gap).toBeLessThan(200);
  },
};

/**
 * The notices box at a small phone's width, in Spanish, whose words are the longest it has, and as
 * on a touch screen (T-233): it fits with what it says once ticked, and a finger reaches the box
 * through its label (ADR-033).
 */
export const ChecklistNoticesAtPhoneWidth: Story = {
  // A client of its own: the default one is shared, and another story may have turned it on.
  args: { client: fakeTrackPeopleClient() },
  decorators: [
    atPhoneWidth,
    (Story) => (
      <I18nProvider locale="es">
        <Story />
      </I18nProvider>
    ),
  ],
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('checkbox', {
      name: 'Avisar a quienes siguen un ticket cuando cambia una lista de comprobación',
    });
    await userEvent.click(box);
    const card = canvas.getByRole('region', { name: 'Avisos a quienes siguen tickets' });
    await expect(
      await within(card).findByText(
        'Quienes siguen tickets de SHOP ahora se enteran cuando cambia una lista de comprobación.',
      ),
    ).toBeVisible();
    await expect(tooSmallForAFinger(card, ['.form-field-inline label'])).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};

/** The same on a phone, already on. */
export const ChecklistNoticesPhone: Story = {
  args: { client: fakeTrackPeopleClient({ checklistNotices: true }) },
  globals: { viewport: { value: 'mobile1' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('checkbox', { name: 'Tell followers when a checklist changes' }),
    ).toBeChecked();
  },
};

export const ChecklistNoticesBoxAlone: StoryObj<typeof ChecklistNoticesBox> = {
  render: () => (
    <ChecklistNoticesBox
      track={{ id: 3, key: 'SHOP' }}
      on={false}
      client={fakeTrackPeopleClient()}
      onSaid={() => {}}
      onRefused={() => {}}
    />
  ),
};

export const TracksYouRun: StoryObj<typeof ManagedTracksPage> = {
  render: () => <ManagedTracksPage client={fakeTrackPeopleClient()} />,
};

const anonymous = (children: React.ReactNode) => (
  <SessionProvider session={{ status: 'anonymous' }}>{children}</SessionProvider>
);
const invited = {
  beforeEach: () => {
    window.sessionStorage.clear();
    window.location.hash = '#/invite?token=story-token';
  },
};

export const InvitationLinkPage: StoryObj<typeof InvitationPage> = {
  ...invited,
  render: () => anonymous(<InvitationPage client={fakeInvitationClient()} />),
};

/** A link that no longer works: said on the same card as Unsubscribe and Consent. */
export const InvitationLinkGone: StoryObj<typeof InvitationPage> = {
  ...invited,
  render: () =>
    anonymous(
      <InvitationPage
        client={{
          ...fakeInvitationClient(),
          inspect: async () => {
            throw new ApiError(404, { error: 'not_found' });
          },
        }}
      />,
    ),
  play: async ({ canvasElement }) => {
    // The frame's one way out, at the top (D24); the problem on its card.
    const link = await within(canvasElement).findByRole('link', { name: 'Go to sign in' });
    await expect(link.closest('.standalone-bar')).not.toBeNull();
    await expect(canvasElement.querySelector('.glass-card .page-note')).not.toBeNull();
  },
};

/** A provider serves the invited address (IAM-032): signing in comes first, with it on offer. */
export const InvitationWithGoogle: StoryObj<typeof InvitationPage> = {
  ...invited,
  render: () =>
    anonymous(
      <InvitationPage
        client={fakeInvitationClient()}
        ssoClient={fakeSignInSso([{ id: 8, name: 'Google' }], {
          'example.com': { provider: { id: 8, name: 'Google' }, password: true },
        })}
      />,
    ),
};

export const InvitationNeedsSecondFactor: StoryObj<typeof InvitationPage> = {
  ...invited,
  render: () =>
    anonymous(<InvitationPage client={fakeInvitationClient({ secondFactorRequired: true })} />),
};

export const InvitationUsedUp: StoryObj<typeof InvitationPage> = {
  ...invited,
  render: () =>
    anonymous(
      <InvitationPage
        client={{
          ...fakeInvitationClient(),
          inspect: async () => {
            throw new ApiError(404, { error: 'invalid_link' });
          },
        }}
      />,
    ),
};

/** A track's people on a phone, each part on its card. */
export const ManagerAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Who holds which role' }),
    ).toBeVisible();
    await expect(canvas.getByText(/^Who has which role in this track/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** Nobody invited yet: a short line inside its card, with no picture. */
export const NoInvitationsWaiting: Story = {
  args: { client: fakeTrackPeopleClient({ invitations: [] }) },
};

export const TracksYouRunAtPhoneWidth: StoryObj<typeof ManagedTracksPage> = {
  decorators: [atPhoneWidth],
  render: () => <ManagedTracksPage client={fakeTrackPeopleClient()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Manage track SHOP' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** Someone who runs no track: what would put one here. */
export const NoTracksYouRun: StoryObj<typeof ManagedTracksPage> = {
  render: () => (
    <ManagedTracksPage client={{ ...fakeTrackPeopleClient(), managedTracks: async () => [] }} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('You do not run any track.')).toBeVisible();
    await expect(canvas.getByText(/^A track shows here once you run it/)).toBeVisible();
  },
};

export const InvitationAtPhoneWidth: StoryObj<typeof InvitationPage> = {
  ...invited,
  decorators: [atPhoneWidth],
  render: () => anonymous(<InvitationPage client={fakeInvitationClient()} />),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('form')).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A row's box on screen, to say where an answer is against it. */
const rect = (element: Element) => element.getBoundingClientRect();
const rowNamed = (list: HTMLElement, text: string) =>
  within(list)
    .getAllByRole('listitem')
    .find((li) => li.textContent?.startsWith(text)) as HTMLElement;
const twoWaiting = () =>
  fakeTrackPeopleClient({
    invitations: [WAITING, { ...WAITING, id: 22, email: 'oli@example.com' }],
    // As for a site administrator, who may copy links where the site sends email (T-053).
    canCopyLinks: true,
  });

/**
 * A long list of who holds which role (T-248): taking a role from someone halfway down says so in
 * that row's place, between the rows around it, not at the foot of the card far below; the
 * page's status line tells a screen reader.
 */
export const AnswerBesideTheRow: Story = {
  args: { client: fakeTrackPeopleClient({ crowd: 12 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole('region', { name: 'Who holds which role' });
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove Member 6 from Members' }),
    );
    const said = await within(card).findByText('Member 6 no longer holds Members.');
    await expect(said).toBeVisible();
    const list = within(card).getAllByRole('list')[0] as HTMLElement;
    await expect(rect(said).top).toBeGreaterThanOrEqual(
      rect(rowNamed(list, 'Member 5: Members')).bottom,
    );
    await expect(rect(said).bottom).toBeLessThanOrEqual(
      rect(rowNamed(list, 'Member 7: Members')).top,
    );
    await waitFor(() =>
      expect(canvas.getByRole('status')).toHaveTextContent('Member 6 no longer holds Members.'),
    );
  },
};

/**
 * A refusal at a small phone's width, in Spanish, as on a touch screen: it wraps inside the row
 * pressed, with nothing sideways, and the buttons still take a finger (ADR-033).
 */
export const AnswerBesideTheRowAtPhoneWidth: Story = {
  args: { client: fakeTrackPeopleClient({ crowd: 12 }) },
  decorators: [
    atPhoneWidth,
    (Story) => (
      <I18nProvider locale="es">
        <Story />
      </I18nProvider>
    ),
  ],
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole('region', { name: 'Quién tiene cada rol' });
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Quitar Administrators a Kalo Reyes' }),
    );
    const alert = await within(card).findByRole('alert');
    await expect(alert).toBeVisible();
    const row = alert.closest('li') as HTMLElement;
    await expect(row).toHaveTextContent('Kalo Reyes');
    await expect(rect(alert).left).toBeGreaterThanOrEqual(rect(row).left);
    await expect(rect(alert).right).toBeLessThanOrEqual(rect(row).right + 0.5);
    await expect(tooSmallForAFinger(card, ['.people-action'])).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};

/** Two invitations waiting: one sent again says so in its own row, not in the other's (T-248). */
export const InvitationAnswerInItsRow: Story = {
  args: { client: twoWaiting() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole('region', { name: 'Invitations waiting' });
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Send again to oli@example.com' }),
    );
    const list = within(card).getByRole('list');
    await expect(
      await within(rowNamed(list, 'oli@example.com')).findByText(
        'The invitation to oli@example.com went out again.',
      ),
    ).toBeVisible();
    await expect(rowNamed(list, 'nia@example.com')).not.toHaveTextContent('went out again');
  },
};

/** A new link at a small phone's width, as on a touch screen: in its own row, fitting. */
export const InvitationAnswerInItsRowAtPhoneWidth: Story = {
  args: { client: twoWaiting() },
  decorators: [atPhoneWidth],
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole('region', { name: 'Invitations waiting' });
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Make a new link for oli@example.com' }),
    );
    const row = rowNamed(within(card).getByRole('list'), 'oli@example.com');
    await expect(
      await within(row).findByRole('textbox', { name: 'Link for oli@example.com' }),
    ).toBeVisible();
    await expect(
      await within(row).findByText(
        'There is a new link for oli@example.com; the old one no longer works.',
      ),
    ).toBeVisible();
    await expect(tooSmallForAFinger(card, ['.people-action'])).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
import { fakeSignInSso } from '../sso/fixtures';
import { ChecklistNoticesBox } from './ChecklistNoticesBox';
import { CreateTracksBox } from './CreateTracksBox';
import { fakeInvitationClient, fakeTrackPeopleClient, ROLES } from './fixtures';
import { InvitationPage } from './InvitationPage';
import { InviteDialog } from './InviteDialog';
import { ManagedTracksPage } from './ManagedTracksPage';
import { TrackPeoplePage } from './TrackPeoplePage';

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

export const AppointingRemoved: Story = {
  args: { client: fakeTrackPeopleClient({ appointLocked: true }) },
};

export const InvitingOff: Story = {
  args: { client: fakeTrackPeopleClient({ canInvite: false, invitingGiven: false }) },
};

export const NoMailServer: Story = {
  args: { client: fakeTrackPeopleClient({ emailAvailable: false }) },
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

/** Whoever runs the track has its followers told of checklist changes (NTF-015). */
export const ChecklistNotices: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = await canvas.findByRole('checkbox', {
      name: 'Tell followers when a checklist changes',
    });
    await expect(box).not.toBeChecked();
    await userEvent.click(box);
    await expect(
      await canvas.findByText('Followers of tickets in SHOP now hear when a checklist changes.'),
    ).toBeVisible();
    await expect(box).toBeChecked();
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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { SessionProvider } from '../session/SessionProvider';
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

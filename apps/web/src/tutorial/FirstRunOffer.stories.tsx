import type { Meta, StoryObj } from '@storybook/react-vite';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { FirstRunOffer } from './FirstRunOffer';
import { fakeTutorialClient } from './fixtures';
import { TutorialCoach, TutorialProvider } from './TutorialProvider';

const client = fakeTutorialClient();

const meta = {
  title: 'Tutorial/FirstRunOffer',
  component: FirstRunOffer,
  args: { client },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <TutorialProvider client={client}>
          <main id="main" tabIndex={-1} style={{ padding: 24 }}>
            <Story />
            <TutorialCoach />
          </main>
        </TutorialProvider>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof FirstRunOffer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At a person's first sign-in, at the top of Home: the everyday sections, three ticked (ADR-115). */
export const FirstSignIn: Story = {};

/** Seen before, or answered: one small Getting started link, so the person's own work comes first (D10). */
export const SeenBefore: Story = {
  args: { client: fakeTutorialClient({ offer: 'shown', sections: [] }) },
};

/** A site administrator is offered Workflows, Administration and Import too. */
export const SiteAdministrator: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <Story />
      </SessionProvider>
    ),
  ],
};

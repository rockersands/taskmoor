import type { Meta, StoryObj } from '@storybook/react-vite';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeTutorialClient, SOME_PROGRESS } from './fixtures';
import { TutorialCoach, TutorialProvider } from './TutorialProvider';
import { TutorialsPage } from './TutorialsPage';

const meta = {
  title: 'Tutorial/TutorialsPage',
  component: TutorialsPage,
  args: { client: fakeTutorialClient(SOME_PROGRESS) },
  decorators: [
    (Story, { args }) => (
      <SessionProvider session={MEMBER}>
        <TutorialProvider {...(args.client ? { client: args.client } : {})}>
          <main id="main" tabIndex={-1} style={{ padding: 24 }}>
            <Story />
            <TutorialCoach />
          </main>
        </TutorialProvider>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof TutorialsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Settings, Tutorials: each section with its state, to start, resume or do again (ADR-115). */
export const WithProgress: Story = {};

/** Nothing started yet, for a site administrator: every section, all ticked. */
export const FreshAdministrator: Story = {
  args: { client: fakeTutorialClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <Story />
      </SessionProvider>
    ),
  ],
};

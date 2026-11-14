import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
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

/**
 * Every Start button is the same height and sits at the foot of its card, also beside a card with
 * a longer text in the same row (S3-AC-2): the grid row stretched the shorter card's button.
 */
export const StartButtonsOneHeight: Story = {
  args: { client: fakeTutorialClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={ADMIN}>
        <div style={{ width: 960 }}>
          <Story />
        </div>
      </SessionProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const starts = await waitFor(() => {
      const found = [...canvasElement.querySelectorAll<HTMLElement>('.tutorial-card-start')];
      if (found.length < 2) throw new Error('no Start buttons yet');
      return found;
    });
    const heights = starts.map((b) => Math.round(b.getBoundingClientRect().height));
    await expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    for (const button of starts) {
      const card = button.closest('.tutorial-card') as HTMLElement;
      const gap = card.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom;
      await expect(gap).toBeLessThanOrEqual(parseFloat(getComputedStyle(card).paddingBottom) + 1);
    }
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { fn } from 'storybook/test';
import { CoachCard, PausedCoach, Spotlight } from './CoachCard';

const meta = {
  title: 'Tutorial/CoachCard',
  component: CoachCard,
  args: {
    sectionTitle: 'Dashboards',
    title: 'Make a dashboard',
    body: 'Type a name and choose Create dashboard. Only you see it until you share it.',
    index: 2,
    count: 6,
    waiting: true,
    goThere: null,
    made: null,
    focusKey: 0,
    onBack: fn(),
    onNext: fn(),
    onPause: fn(),
    onSkip: fn(),
  },
} satisfies Meta<typeof CoachCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A step that waits for the person: it moves on by itself once they have done it (ADR-115). */
export const Waiting: Story = {};

/** Away from the step's page: the card offers the way there. */
export const Away: Story = { args: { goThere: '#/dashboards' } };

/** The first step: what the section makes, and that it is real. */
export const First: Story = {
  args: {
    title: 'Dashboards',
    body: 'A dashboard puts the lists and numbers you check often on one page. You will make one and add a widget. It is real and stays in this instance.',
    index: 0,
    waiting: false,
  },
};

/** The last step: Finish, and the page of what was made, to keep it or delete it. */
export const Last: Story = {
  args: {
    title: 'Your dashboard is ready',
    body: 'It stays in this instance. On its page you can share it, show it as a wallboard or delete it.',
    index: 5,
    waiting: false,
    made: '#/dashboards/7',
  },
};

/** Over a page: the ring around the control to use, the rest dimmed but usable. */
export const OverAPage: Story = {
  render: (args) => {
    const card = useRef<HTMLDivElement | null>(null);
    return (
      <main style={{ padding: 32 }}>
        <h1>Dashboards</h1>
        <form data-tutorial="dashboard-new" style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
          <label>
            Name <input />
          </label>
          <button type="button" className="button-primary">
            Create dashboard
          </button>
        </form>
        <Spotlight target="dashboard-new" card={card} />
        <CoachCard {...args} cardRef={card} />
      </main>
    );
  },
};

/** Paused: the place kept, one press from going on. */
export const Paused: Story = {
  render: () => (
    <PausedCoach sectionTitle="Dashboards" index={2} count={6} onResume={fn()} onClose={fn()} />
  ),
};

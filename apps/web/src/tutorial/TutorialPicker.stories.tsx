import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { audienceOf, sectionsFor } from './sections';
import { TutorialPicker } from './TutorialPicker';

const meta = {
  title: 'Tutorial/TutorialPicker',
  component: TutorialPicker,
  args: {
    sections: sectionsFor(audienceOf({ isSiteAdmin: true })),
    status: { tracks: 'done', boards: 'active', search: 'skipped' },
    selected: ['boards', 'dashboards'],
    onSelect: fn(),
    onStart: fn(),
  },
} satisfies Meta<typeof TutorialPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every section, for a site administrator, with some progress (ADR-115). */
export const Administrator: Story = {};

/** Without the sections that need an administrator. */
export const Member: Story = {
  args: { sections: sectionsFor(audienceOf({ isSiteAdmin: false })), status: {}, selected: [] },
};

/** A configuration administrator: Workflows too, marked for administrators. */
export const ConfigurationAdministrator: Story = {
  args: {
    sections: sectionsFor(audienceOf({ isSiteAdmin: false, isConfigAdmin: true })),
    status: {},
    selected: ['workflows'],
  },
};

/** As the first-run offer shows it: cards to tick, without a button on each. */
export const ToTickOnly: Story = {
  args: { status: {}, selected: ['tracks', 'boards', 'search'] },
  render: ({ onStart: _start, ...args }) => <TutorialPicker {...args} />,
};

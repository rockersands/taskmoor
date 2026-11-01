import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PEOPLE } from './fixtures';
import { PeopleMapping } from './PeopleMapping';

function Mapping({ more }: { more?: boolean }) {
  const [value, setValue] = useState<Record<string, string>>({ linus: 'linus@example.org' });
  return <PeopleMapping people={PEOPLE} value={value} onChange={setValue} more={more ?? false} />;
}

const meta = {
  title: 'Admin/Imports/PeopleMapping',
  component: Mapping,
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Mapping>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three people: one matched by address, one without one, one mapped by hand. */
export const ThreePeople: Story = {};

/** More people than the dry run lists. */
export const More: Story = { args: { more: true } };

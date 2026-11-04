import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { DefinitionText, legendOf } from './DefinitionText';
import { formatDefinition } from './definition';
import { STATUSES, STEPPED_DEFINITION } from './fixtures';

function Holder({ initial, invalid = false }: { initial: string; invalid?: boolean }) {
  const [text, setText] = useState(initial);
  return (
    <DefinitionText
      text={text}
      onChange={setText}
      invalid={invalid}
      statuses={legendOf(
        STATUSES,
        STEPPED_DEFINITION.statuses.map((s) => s.statusId),
      )}
    />
  );
}

const meta = {
  title: 'Workflows/DefinitionText',
  component: Holder,
  args: { initial: formatDefinition(STEPPED_DEFINITION) },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Definition: Story = {};

export const NotValidJson: Story = {
  args: { initial: '{\n  "initialStatusId": 2,\n  "statuses": [\n', invalid: true },
};

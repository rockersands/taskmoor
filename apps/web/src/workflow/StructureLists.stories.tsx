import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { addStatus, type WorkflowDefinition } from './definition';
import { namesFor } from './describe';
import { STATUSES, STEPPED_DEFINITION, SUPPORT_DEFINITION } from './fixtures';
import { lintDefinition } from './lint';
import { StructureLists } from './StructureLists';
import type { Selection } from './WorkflowDiagram';

function Holder({ definition: initial }: { definition: WorkflowDefinition }) {
  const t = useT();
  const [definition, setDefinition] = useState(initial);
  const [selection, setSelection] = useState<Selection>(null);
  const stages = new Map(STATUSES.map((s) => [s.id, s.stage]));
  return (
    <StructureLists
      definition={definition}
      statuses={STATUSES}
      stages={stages}
      names={namesFor(t, STATUSES, definition)}
      issues={lintDefinition(definition, stages)}
      selection={selection}
      onSelect={setSelection}
      onAddStatus={(id) => setDefinition(addStatus(definition, id))}
      onAddTransition={() => {}}
    />
  );
}

const meta = {
  title: 'Workflows/StructureLists',
  component: Holder,
  args: { definition: STEPPED_DEFINITION },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 1000 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultWorkflow: Story = {};

export const WithWarnings: Story = { args: { definition: SUPPORT_DEFINITION } };

export const Empty: Story = {
  args: { definition: { initialStatusId: 1, statuses: [{ statusId: 1 }], transitions: [] } },
};

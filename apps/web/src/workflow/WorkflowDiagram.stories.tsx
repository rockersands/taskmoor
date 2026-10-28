import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { WorkflowDefinition } from './definition';
import { namesFor } from './describe';
import { DEFAULT_DEFINITION, STATUSES, SUPPORT_DEFINITION } from './fixtures';
import { lintDefinition } from './lint';
import { type Selection, WorkflowDiagram } from './WorkflowDiagram';

function Holder({
  definition,
  selected = null,
}: {
  definition: WorkflowDefinition;
  selected?: Selection;
}) {
  const t = useT();
  const [selection, setSelection] = useState<Selection>(selected);
  const stages = new Map(STATUSES.map((s) => [s.id, s.stage]));
  const issues = lintDefinition(definition, stages);
  return (
    <WorkflowDiagram
      definition={definition}
      stages={stages}
      names={namesFor(t, STATUSES, definition)}
      selection={selection}
      onSelect={setSelection}
      flagged={{
        statuses: new Set(issues.flatMap((i) => ('statusId' in i ? [i.statusId] : []))),
        transitions: new Set(issues.flatMap((i) => ('transitionId' in i ? [i.transitionId] : []))),
      }}
    />
  );
}

const meta = {
  title: 'Workflows/WorkflowDiagram',
  component: Holder,
  args: { definition: DEFAULT_DEFINITION },
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

export const DefaultWorkflow: Story = {};

export const WithWarnings: Story = { args: { definition: SUPPORT_DEFINITION } };

export const TransitionSelected: Story = {
  args: { definition: SUPPORT_DEFINITION, selected: { kind: 'transition', id: 2 } },
};

export const StatusSelected: Story = {
  args: { definition: DEFAULT_DEFINITION, selected: { kind: 'status', id: 5 } },
};

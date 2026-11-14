import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { useT } from '../i18n/I18nProvider';
import type { WorkflowDefinition } from './definition';
import { namesFor } from './describe';
import { S, STATUSES, STEPPED_DEFINITION, SUPPORT_DEFINITION } from './fixtures';
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
  args: { definition: STEPPED_DEFINITION },
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
  args: { definition: STEPPED_DEFINITION, selected: { kind: 'status', id: 5 } },
};

/** New, Active and In Review in one row: two global transitions into Active, one into each other. */
const CROWDED_TABS: WorkflowDefinition = {
  initialStatusId: S.New as number,
  statuses: [S.New, S.Active, S['In Review']].map((statusId) => ({ statusId: statusId as number })),
  transitions: [
    { id: 1, name: 'Start', from: [S.New as number], to: S.Active as number },
    { id: 2, name: 'Send to review', from: [S.Active as number], to: S['In Review'] as number },
    { id: 3, name: 'Pick up again', from: 'any', to: S.Active as number },
    { id: 4, name: 'Take over', from: 'any', to: S.Active as number },
    { id: 5, name: 'Ask for a second review', from: 'any', to: S['In Review'] as number },
    { id: 6, name: 'Start over from the beginning', from: 'any', to: S.New as number },
  ],
};

/**
 * Lone "from any status" tabs beside a status with two: no tab overlaps another or reaches over
 * the next column's box (T-255).
 */
export const LoneTabsBesideTwo: Story = {
  args: { definition: CROWDED_TABS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: /Take over/ });
    const rect = (element: Element) => element.getBoundingClientRect();
    const tabs = Array.from(canvasElement.querySelectorAll('.workflow-edge-tab')).map(rect);
    const boxes = Array.from(canvasElement.querySelectorAll('.workflow-node')).map(rect);
    await expect(tabs).toHaveLength(4);
    const apart = (a: DOMRect, b: DOMRect) =>
      a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    const overlaps = tabs.flatMap((a, i) =>
      tabs
        .slice(i + 1)
        .flatMap((b) => (apart(a, b) ? [] : [`${a.left}-${a.right} ${b.left}-${b.right}`])),
    );
    await expect(overlaps).toEqual([]);
    // The three boxes share a row: a tab over two of them reaches into the next column.
    const over = (tab: DOMRect) =>
      boxes.filter((box) => tab.left < box.right && box.left < tab.right).length;
    await expect(tabs.map(over).filter((n) => n > 1)).toEqual([]);
  },
};

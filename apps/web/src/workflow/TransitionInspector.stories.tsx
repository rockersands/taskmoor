import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactElement, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { useT } from '../i18n/I18nProvider';
import { updateTransition, type WorkflowDefinition, withRules } from './definition';
import { namesFor } from './describe';
import { LOOKUPS, STATUSES, SUPPORT_DEFINITION } from './fixtures';
import { TransitionInspector } from './TransitionInspector';

function Holder({
  transitionId,
  lookups = LOOKUPS,
}: {
  transitionId: number;
  lookups?: typeof LOOKUPS;
}) {
  const t = useT();
  const [definition, setDefinition] = useState<WorkflowDefinition>(SUPPORT_DEFINITION);
  const transition = definition.transitions.find((x) => x.id === transitionId);
  if (!transition) return null;
  return (
    <TransitionInspector
      transition={transition}
      definition={definition}
      names={namesFor(t, STATUSES, definition)}
      context={{
        statuses: STATUSES,
        transitions: definition.transitions.map((x) => ({ id: x.id, name: x.name })),
        lookups,
      }}
      onChange={(next) => setDefinition(updateTransition(definition, transitionId, () => next))}
      onRulesChange={(rules) => setDefinition(withRules(definition, transitionId, rules))}
      onDelete={() => {}}
    />
  );
}

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

const meta = {
  title: 'Workflows/TransitionInspector',
  component: Holder,
  args: { transitionId: 1 },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 560 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Holder>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nested guards, an effect and a local-mode rule. */
export const GuardsAndRules: Story = {};

/** A layout field, checks with a message and a property. */
export const ChecksAndProperties: Story = { args: { transitionId: 2 } };

/** A custom event, a webhook and separation of duties. */
export const EffectsAndEvent: Story = { args: { transitionId: 3 } };

export const GlobalTransition: Story = { args: { transitionId: 4 } };

/** Without the role and group lists, pickers take ids. */
export const IdsWithoutNames: Story = {
  args: {
    transitionId: 1,
    lookups: { roles: null, groups: null, permissions: null },
  },
};

export const AddingACheck: Story = {
  args: { transitionId: 5 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText('New check'), 'regex');
    await userEvent.click(canvas.getByRole('button', { name: 'Add check' }));
    await expect(
      canvas.getByRole('group', { name: 'Check 1: A field matches a pattern' }),
    ).toBeVisible();
  },
};

export const ConfirmingDelete: Story = {
  args: { transitionId: 5 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete transition' }));
    await expect(canvas.getByRole('button', { name: 'Delete transition' })).toHaveFocus();
  },
};

/** The stacked panel on a phone: its fieldsets keep to the width. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: /^Transition:/ })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

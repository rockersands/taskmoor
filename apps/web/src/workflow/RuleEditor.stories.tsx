import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { useT } from '../i18n/I18nProvider';
import type { GuardNode } from './definition';
import { LOOKUPS, STATUSES } from './fixtures';
import { GuardTree, type PickerContext, RuleList } from './RuleEditor';

const CONTEXT: PickerContext = {
  statuses: STATUSES,
  transitions: [
    { id: 1, name: 'Take' },
    { id: 2, name: 'Ask for review' },
  ],
  lookups: LOOKUPS,
};

type Rule = { type: string } & Record<string, unknown>;

function Holder({
  guards: initialGuards,
  checks: initialChecks = [],
  rules: initialRules = [],
}: {
  guards?: GuardNode;
  checks?: Rule[];
  rules?: Rule[];
}) {
  const t = useT();
  const [guards, setGuards] = useState(initialGuards);
  const [checks, setChecks] = useState(initialChecks);
  const [rules, setRules] = useState(initialRules);
  return (
    <div className="form workflow-form">
      <fieldset>
        <legend>{t('admin.workflow.transition.guards')}</legend>
        <GuardTree guards={guards} onChange={setGuards} context={CONTEXT} />
      </fieldset>
      <fieldset>
        <legend>{t('admin.workflow.transition.checks')}</legend>
        <RuleList
          kind="check"
          rules={checks}
          onChange={setChecks}
          context={CONTEXT}
          emptyText={t('admin.workflow.transition.noChecks')}
        />
      </fieldset>
      <fieldset>
        <legend>{t('admin.workflow.transition.rules')}</legend>
        <RuleList
          kind="rule"
          rules={rules}
          onChange={setRules}
          context={CONTEXT}
          emptyText={t('admin.workflow.transition.noRules')}
        />
      </fieldset>
    </div>
  );
}

const meta = {
  title: 'Workflows/RuleEditor',
  component: Holder,
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

export const NestedGuards: Story = {
  args: {
    guards: {
      any: [
        { type: 'only-assignee' },
        {
          all: [
            { type: 'user-in-any-role', roles: ['2', '3'] },
            { type: 'compare-number', field: 'original-estimate', op: '<=', value: 28_800 },
          ],
        },
      ],
    },
  },
};

export const EveryCheckForm: Story = {
  args: {
    checks: [
      { type: 'date-compare', field: 'start-date', op: '<=', other: 'due-date', includeTime: true },
      { type: 'date-window', field: 'due-date', other: 'start-date', days: 14 },
      { type: 'parent-status', statuses: ['5', '6'] },
      { type: 'previous-state', status: '6', mostRecentOnly: true, message: 'Review it first.' },
    ],
    rules: [
      { type: 'restrict-been-through', status: '6', includeCurrent: true },
      { type: 'restrict-who', users: ['7', '9'], groups: ['1'] },
      { type: 'assign', to: { user: '12' } },
      { type: 'update-field', field: 'labels', value: ['urgent'] },
    ],
  },
};

export const AddingAGroup: Story = {
  args: { guards: { all: [{ type: 'only-requester' }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Add a group' }));
    await expect(canvas.getByRole('group', { name: 'Group 2: one must pass' })).toBeVisible();
  },
};

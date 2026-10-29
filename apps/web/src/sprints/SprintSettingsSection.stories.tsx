import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { NumberField, SprintSettings } from './client';
import { SprintSettingsSection, sprintDraftOf } from './SprintSettingsSection';

const FIELDS: NumberField[] = [
  { id: 31, name: 'Story points' },
  { id: 32, name: 'Business value' },
];
const DEFAULTS: SprintSettings = {
  estimation: { statistic: 'originalEstimate' },
  timeTracking: 'remainingEstimate',
  parallelSprints: false,
  cycle: null,
};

interface SectionProps {
  settings: SprintSettings;
  numberFields: NumberField[];
  problems: Record<string, string>;
}

function Section({ settings, numberFields, problems }: SectionProps) {
  const [draft, setDraft] = useState(() => sprintDraftOf(settings, 'Europe/Madrid'));
  return (
    <main style={{ padding: 24, maxWidth: '48rem' }}>
      <form>
        <SprintSettingsSection
          value={draft}
          onChange={(change) => setDraft({ ...draft, ...change })}
          numberFields={numberFields}
          problems={problems}
        />
      </form>
    </main>
  );
}

const meta = {
  title: 'Sprints/SprintSettingsSection',
  component: Section,
  args: { settings: DEFAULTS, numberFields: FIELDS, problems: {} },
} satisfies Meta<typeof Section>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new Scrum board's settings: time estimates, remaining estimate tracking, no cycle. */
export const Defaults: Story = {};

/** Story points and a two-week cycle, turned on from the defaults. */
export const Cycle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Estimate with' }), 'field');
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Number field' }),
      'Story points',
    );
    await userEvent.click(
      canvas.getByRole('checkbox', { name: 'Roll sprints over automatically' }),
    );
    await expect(canvas.getByRole('spinbutton', { name: 'Days in each sprint' })).toHaveValue(14);
    await expect(
      canvas.getByRole('combobox', { name: 'Time zone of the cycle' }),
    ).toHaveDisplayValue('Europe/Madrid');
  },
};

/** No number field to estimate with yet: the saved field shows by its id. */
export const NoNumberFields: Story = {
  args: {
    settings: { ...DEFAULTS, estimation: { statistic: 'field', fieldId: 77 } },
    numberFields: [],
  },
};

/** The server's refusals, each next to its field. */
export const Refused: Story = {
  args: {
    settings: {
      estimation: { statistic: 'field', fieldId: 32 },
      timeTracking: 'none',
      parallelSprints: true,
      cycle: { lengthDays: 14, timeZone: 'Europe/Madrid' },
    },
    problems: {
      'sprintSettings.estimation.fieldId': 'not_a_number_field',
      'sprintSettings.cycle': 'not_with_parallel_sprints',
      'sprintSettings.cycle.timeZone': 'unknown_time_zone',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('checkbox', { name: 'Roll sprints over automatically' }),
    ).toBeInvalid();
  },
};

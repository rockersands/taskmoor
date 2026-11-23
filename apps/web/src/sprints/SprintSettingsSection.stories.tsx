import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { I18nProvider } from '../i18n/I18nProvider';
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

/** How wide a select's chosen words are, in its own font. */
function wordsWidth(select: HTMLSelectElement): number {
  const pen = document.createElement('canvas').getContext('2d');
  if (!pen) throw new Error('no canvas to measure with');
  const style = getComputedStyle(select);
  pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return pen.measureText(select.selectedOptions[0]?.textContent ?? '').width;
}

/**
 * In Spanish at a phone's width (S3-TR-5, S3-TR-6): the time tracking choice reads whole, clear of
 * the select's arrow, and the check boxes sit the section's own gap from the fields around them,
 * with no empty band.
 */
export const SpanishOnAPhone: Story = {
  render: (args) => (
    <I18nProvider locale="es">
      <div style={{ width: 375 }}>
        <Section {...args} />
      </div>
    </I18nProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tracking = canvas.getByRole<HTMLSelectElement>('combobox', {
      name: 'Registro de tiempo',
    });
    const style = getComputedStyle(tracking);
    // The arrow takes about a line's height at the end of the field.
    const room =
      tracking.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      Number.parseFloat(style.fontSize) * 1.5;
    await expect(wordsWidth(tracking)).toBeLessThanOrEqual(room);
    const section = canvasElement.querySelector('fieldset');
    if (!section) throw new Error('the section is drawn');
    const gap = Number.parseFloat(getComputedStyle(section).rowGap);
    const field = tracking.closest('.form-field')?.getBoundingClientRect();
    const options = Array.from(
      canvasElement.querySelectorAll('.sprint-settings-option'),
      (option) => option.getBoundingClientRect(),
    );
    const [parallel, cycle] = options;
    if (!field || !parallel || !cycle) throw new Error('the options are drawn');
    await expect(Math.round(parallel.top - field.bottom)).toBe(Math.round(gap));
    await expect(Math.round(cycle.top - parallel.bottom)).toBe(Math.round(gap));
  },
};

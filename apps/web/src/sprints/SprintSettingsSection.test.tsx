import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { NumberField, SprintSettings } from './client';
import {
  type SprintDraft,
  SprintSettingsSection,
  sprintDraftOf,
  sprintSettingsOf,
} from './SprintSettingsSection';

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

/** The section with its draft kept in state, as the board settings page keeps it. */
function renderSection(
  options: {
    settings?: SprintSettings;
    numberFields?: NumberField[];
    problems?: Record<string, string>;
    locale?: Locale;
  } = {},
) {
  const drafts: SprintDraft[] = [];
  function Harness() {
    const [draft, setDraft] = useState(() =>
      sprintDraftOf(options.settings ?? DEFAULTS, 'America/New_York'),
    );
    drafts.push(draft);
    return (
      <SprintSettingsSection
        value={draft}
        onChange={(change) => setDraft({ ...draft, ...change })}
        numberFields={options.numberFields ?? FIELDS}
        problems={options.problems ?? {}}
      />
    );
  }
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <main>
        <Harness />
      </main>
    </I18nProvider>,
  );
  return { saved: () => sprintSettingsOf(drafts[drafts.length - 1] as SprintDraft) };
}
const section = () => screen.getByRole('group', { name: 'Sprints' });

describe('sprint settings section (M1-044, M1-045)', () => {
  it('[AGL-007] estimates with a number field picked from the number fields', async () => {
    const user = userEvent.setup();
    const { saved } = renderSection();
    const sprints = within(section());
    expect(sprints.queryByRole('combobox', { name: 'Number field' })).toBeNull();
    await user.selectOptions(sprints.getByRole('combobox', { name: 'Estimate with' }), 'field');
    const picker = sprints.getByRole('combobox', { name: 'Number field' });
    expect(picker).toBeRequired();
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Pick a number field', 'Story points', 'Business value']);
    await user.selectOptions(picker, 'Business value');
    await user.selectOptions(sprints.getByRole('combobox', { name: 'Time tracking' }), 'none');
    expect(saved()).toEqual({
      estimation: { statistic: 'field', fieldId: 32 },
      timeTracking: 'none',
      parallelSprints: false,
      cycle: null,
    });
    // Back to ticket count: the field goes with the statistic.
    await user.selectOptions(
      sprints.getByRole('combobox', { name: 'Estimate with' }),
      'ticketCount',
    );
    expect(saved().estimation).toEqual({ statistic: 'ticketCount' });
  });

  it('[AGL-007] keeps a saved field the person cannot see, and says when there is none', () => {
    renderSection({
      settings: { ...DEFAULTS, estimation: { statistic: 'field', fieldId: 77 } },
      numberFields: [],
    });
    const picker = screen.getByRole('combobox', { name: 'Number field' });
    expect(picker).toHaveDisplayValue('Field 77');
    expect(picker).toHaveAccessibleDescription(
      'There are no number fields yet. An administrator adds them on the Fields page.',
    );
  });

  it('[AGL-011] [AGL-012] turns a cycle on with a length and a time zone, and off again', async () => {
    const user = userEvent.setup();
    const { saved } = renderSection();
    const sprints = within(section());
    await user.click(
      sprints.getByRole('checkbox', { name: 'Allow several active sprints at once' }),
    );
    expect(saved().parallelSprints).toBe(true);
    await user.click(
      sprints.getByRole('checkbox', { name: 'Allow several active sprints at once' }),
    );
    expect(sprints.queryByRole('spinbutton', { name: 'Days in each sprint' })).toBeNull();
    const cycle = sprints.getByRole('checkbox', { name: 'Roll sprints over automatically' });
    expect(cycle).toHaveAccessibleDescription(/A cycle runs one sprint at a time\.$/);
    await user.click(cycle);
    // Two weeks on the person's time zone to begin with.
    const length = sprints.getByRole('spinbutton', { name: 'Days in each sprint' });
    expect(length).toHaveValue(14);
    expect(length).toHaveAccessibleDescription('From 1 to 91 days.');
    const zone = sprints.getByRole('combobox', { name: 'Time zone of the cycle' });
    expect(zone).toHaveDisplayValue('America/New York');
    await user.clear(length);
    await user.type(length, '10');
    await user.selectOptions(zone, 'Europe/Madrid');
    expect(saved().cycle).toEqual({ lengthDays: 10, timeZone: 'Europe/Madrid' });
    await user.click(cycle);
    expect(sprints.queryByRole('combobox', { name: 'Time zone of the cycle' })).toBeNull();
    expect(saved().cycle).toBeNull();
  });

  it('[AGL-007] [AGL-012] explains each refusal next to its field', () => {
    renderSection({
      settings: {
        ...DEFAULTS,
        estimation: { statistic: 'field', fieldId: 32 },
        parallelSprints: true,
        cycle: { lengthDays: 14, timeZone: 'Europe/Madrid' },
      },
      problems: {
        'sprintSettings.estimation.fieldId': 'not_a_number_field',
        'sprintSettings.cycle': 'not_with_parallel_sprints',
        'sprintSettings.cycle.timeZone': 'unknown_time_zone',
        'sprintSettings.cycle.lengthDays': 'Number must be less than or equal to 91',
      },
    });
    const picker = screen.getByRole('combobox', { name: 'Number field' });
    expect(picker).toBeInvalid();
    expect(picker).toHaveAccessibleDescription(
      'This field is not a number field, or it no longer exists. Pick another.',
    );
    const cycle = screen.getByRole('checkbox', { name: 'Roll sprints over automatically' });
    expect(cycle).toBeInvalid();
    expect(cycle).toHaveAccessibleDescription(
      /A cycle runs one sprint at a time\. Turn off several active sprints to use it\.$/,
    );
    expect(
      screen.getByRole('combobox', { name: 'Time zone of the cycle' }),
    ).toHaveAccessibleDescription(/The server does not know this time zone\. Pick another\.$/);
    expect(
      screen.getByRole('spinbutton', { name: 'Days in each sprint' }),
    ).toHaveAccessibleDescription('From 1 to 91 days. Enter a whole number of days from 1 to 91.');
    // Untouched settings stay unmarked.
    expect(screen.getByRole('combobox', { name: 'Time tracking' })).toBeValid();
  });

  it('[AGL-012] fits a small phone', async () => {
    act(() => setViewportWidth(375));
    const user = userEvent.setup();
    const { saved } = renderSection();
    await user.click(screen.getByRole('checkbox', { name: 'Roll sprints over automatically' }));
    const zone = screen.getByRole('combobox', { name: 'Time zone of the cycle' });
    expect(zone).toBeVisible();
    await user.selectOptions(zone, 'Asia/Tokyo');
    expect(saved().cycle).toEqual({ lengthDays: 14, timeZone: 'Asia/Tokyo' });
  });

  it('passes every string through the pseudo-locale', () => {
    renderSection({
      locale: 'en-XA',
      settings: {
        ...DEFAULTS,
        estimation: { statistic: 'field', fieldId: 77 },
        cycle: { lengthDays: 14, timeZone: 'UTC' },
      },
      numberFields: [],
      problems: { 'sprintSettings.cycle.timeZone': 'unknown_time_zone' },
    });
    expect(untranslated(visibleTexts(screen.getByRole('main')))).toEqual([]);
  });
});

describe('sprint settings drafts', () => {
  it('[AGL-012] reads saved settings back as they were saved', () => {
    const settings: SprintSettings = {
      estimation: { statistic: 'field', fieldId: 31 },
      timeTracking: 'none',
      parallelSprints: false,
      cycle: { lengthDays: 7, timeZone: 'Pacific/Auckland' },
    };
    expect(sprintSettingsOf(sprintDraftOf(settings, 'UTC'))).toEqual(settings);
    // Settings saved before cycles existed have none.
    const { cycle: _cycle, ...older } = DEFAULTS;
    expect(sprintSettingsOf(sprintDraftOf(older, 'UTC'))).toEqual(DEFAULTS);
  });
});

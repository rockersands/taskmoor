import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import type { SavedTemplate, TemplateOptions } from './client';
import { bodyOf, draftOf, saveRefusalOf } from './draft';
import {
  EVERY_TRACK_OPTIONS,
  fakeTemplateClient,
  HOTFIX_TEMPLATE,
  RELEASE_TEMPLATE,
  TEMPLATE_OPTIONS,
} from './fixtures';
import { TemplateForm } from './TemplateForm';

function renderForm(
  template: SavedTemplate | null,
  {
    refuse = null as Record<string, string> | null,
    options = TEMPLATE_OPTIONS as TemplateOptions,
    track = 'SHOP' as string | null,
    locale = 'en' as Locale,
  } = {},
) {
  const client = fakeTemplateClient(template ? [template] : [], { options, refuse });
  const saved: SavedTemplate[] = [];
  render(
    <I18nProvider locale={locale}>
      <main>
        <TemplateForm
          client={client}
          track={track}
          options={options}
          template={template}
          onSaved={(s) => saved.push(s)}
          onCancel={() => {}}
        />
      </main>
    </I18nProvider>,
  );
  const form = screen.getByRole('form');
  return { client, saved, form };
}

const save = async (form: HTMLElement) => {
  await userEvent.click(within(form).getByRole('button', { name: 'Save the template' }));
  return within(form).findByRole('alert');
};

describe('the ticket template form names why a save was refused (CORE-029, T-291)', () => {
  it('[CORE-029] shows each refused value’s reason under its control, with the create form’s words', async () => {
    const { form } = renderForm(RELEASE_TEMPLATE, {
      refuse: {
        'defaults.priorityId': 'not_found',
        'defaults.fields.7': 'not_in_track',
        'subtickets.1.summary': 'too_long',
      },
    });
    expect(await save(form)).toHaveTextContent(
      'Some values cannot be used. The reason is under each of them.',
    );
    const priority = within(form).getByRole('combobox', { name: 'Priority' });
    expect(priority).toHaveAttribute('aria-invalid', 'true');
    expect(priority).toHaveAccessibleDescription('This choice is not available.');
    const severity = within(form).getByRole('combobox', { name: 'Severity' });
    expect(severity).toHaveAttribute('aria-invalid', 'true');
    expect(severity).toHaveAccessibleDescription(
      'This track does not offer this choice. Choose one of its own.',
    );
    expect(
      within(form).getByRole('textbox', { name: 'Subticket 2: summary' }),
    ).toHaveAccessibleDescription('This value is too long.');
    // The others stay as they were.
    const first = within(form).getByRole('textbox', { name: 'Subticket 1: summary' });
    expect(first).not.toHaveAttribute('aria-invalid');
    expect(within(form).getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid');
  });

  it('[CORE-029] [CORE-016] says an archived release is archived, in its own field and in a custom one', async () => {
    const { form } = renderForm(HOTFIX_TEMPLATE, {
      refuse: { 'defaults.targetReleaseIds.0': 'archived', 'defaults.fields.12': 'archived' },
    });
    await save(form);
    const target = within(form).getByRole('listbox', { name: 'Target releases' });
    expect(target).toHaveAttribute('aria-invalid', 'true');
    expect(target).toHaveAccessibleDescription('This release or area is archived. Choose another.');
    expect(within(form).getByRole('list', { name: 'Fixed in' })).toHaveAccessibleDescription(
      /This release or area is archived\. Choose another\.$/,
    );
    expect(within(form).getByRole('list', { name: 'Owning area' })).toHaveAccessibleDescription(
      /^Set through the API\./,
    );
  });

  it('[CORE-029] says a template for every track cannot hold a track’s release', async () => {
    const template: SavedTemplate = {
      ...HOTFIX_TEMPLATE,
      track: null,
      defaults: { fields: { '12': [41] } },
    };
    const { form } = renderForm(template, {
      options: EVERY_TRACK_OPTIONS,
      track: null,
      refuse: { 'defaults.fields.12': 'track_only' },
    });
    await save(form);
    const list = within(form).getByRole('list', { name: 'Fixed in' });
    // Every track has no releases of its own to name it by.
    expect(within(list).getByText('Release 41, not in this track')).toBeVisible();
    expect(list).toHaveAccessibleDescription(
      /Only a track’s template can hold this value: a template for every track cannot\.$/,
    );
  });

  it('[CORE-029] places a subticket’s problem on its row though blank rows are not sent', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(RELEASE_TEMPLATE, {
      refuse: { 'subtickets.0.ticketTypeId': 'not_found', 'subtickets.0.summary': 'too_long' },
    });
    await user.clear(within(form).getByRole('textbox', { name: 'Subticket 1: summary' }));
    await save(form);
    // The body held the second row alone, at index 0.
    expect(client.saved).toEqual([]);
    expect(
      within(form).getByRole('textbox', { name: 'Subticket 2: summary' }),
    ).toHaveAccessibleDescription('This value is too long.');
    expect(
      within(form).getByRole('combobox', { name: 'Subticket 2: type' }),
    ).toHaveAccessibleDescription('This choice is not available.');
    expect(within(form).getByRole('textbox', { name: 'Subticket 1: summary' })).not.toHaveAttribute(
      'aria-invalid',
    );
  });

  it('[CORE-029] keeps the general line for a value the form does not show', async () => {
    const { form } = renderForm(RELEASE_TEMPLATE, {
      refuse: { 'defaults.fields.99': 'read_only', 'defaults.priorityId': 'not_found' },
    });
    expect(await save(form)).toHaveTextContent(
      'Some values cannot be used. Check the days, the fields and the subtickets.',
    );
    // What it can place, it still places.
    expect(within(form).getByRole('combobox', { name: 'Priority' })).toHaveAccessibleDescription(
      'This choice is not available.',
    );
  });

  it('[CORE-029] a name in use is said once, for the whole form', async () => {
    const { form } = renderForm(RELEASE_TEMPLATE, { refuse: { name: 'taken' } });
    expect(await save(form)).toHaveTextContent('Another template here already has that name.');
    expect(within(form).getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid');
  });

  it('[CORE-029] reads the API’s refusals by body path', () => {
    const draft = draftOf(RELEASE_TEMPLATE, TEMPLATE_OPTIONS.fields);
    const refused = (fields: Record<string, string>) =>
      saveRefusalOf(new ApiError(400, { error: 'invalid_fields', fields }), draft);
    expect(refused({ 'defaults.areaIds.1': 'archived', 'ticketTypeIds.0': 'not_found' })).toEqual({
      message: 'tickets.templates.problem.marked',
      at: { areaIds: 'tickets.error.archived', ticketTypeIds: 'tickets.error.notFound' },
    });
    expect(refused({ 'defaults.fields.12.0': 'not_in_track' }).at).toEqual({
      'field:12': 'tickets.error.notInTrack',
    });
    expect(refused({ 'subtickets.5.summary': 'invalid' })).toEqual({
      message: 'tickets.templates.problem.invalid',
      at: {},
    });
    expect(saveRefusalOf(new ApiError(400, { error: 'invalid_request' }), draft)).toEqual({
      message: 'tickets.templates.problem.invalid',
      at: {},
    });
    expect(saveRefusalOf(new ApiError(409, { error: 'version_conflict' }), draft).message).toBe(
      'tickets.templates.problem.conflict',
    );
    expect(saveRefusalOf(new Error('offline'), draft).message).toBe(
      'tickets.templates.problem.other',
    );
  });
});

describe('the ticket template form names custom release and area values (CORE-029, T-291)', () => {
  it('[CORE-029] [CORE-015] [CORE-016] shows them by the track’s names, archived ones marked', () => {
    const { form } = renderForm(HOTFIX_TEMPLATE);
    const fixedIn = within(form).getByRole('list', { name: 'Fixed in' });
    expect(
      within(fixedIn)
        .getAllByRole('listitem')
        .map((li) => li.firstChild?.textContent),
    ).toEqual(['1.0', '0.9 (archived)', 'Release 77, not in this track']);
    const area = within(form).getByRole('list', { name: 'Owning area' });
    expect(within(area).getByText('Checkout')).toBeVisible();
    // The formula field's value is the one the form still cannot show.
    expect(
      within(form).getByText('1 value of a field this form cannot show stays as it is.'),
    ).toBeVisible();
    // An archived release the template holds stays chosen in its own list, marked; archived ones
    // it does not hold are not offered.
    const target = within(form).getByRole('listbox', { name: 'Target releases' });
    expect(within(target).getByRole('option', { name: '0.9 (archived)' })).toHaveProperty(
      'selected',
      true,
    );
    expect(
      within(within(form).getByRole('listbox', { name: 'Areas' })).queryByRole('option', {
        name: /Old storefront/,
      }),
    ).toBeNull();
  });

  it('[CORE-029] removes one, the focus on the next, and saves the rest as the field takes them', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(HOTFIX_TEMPLATE);
    await user.click(
      within(form).getByRole('button', { name: 'Remove 0.9 (archived) from Fixed in' }),
    );
    expect(
      within(form).getByRole('button', {
        name: 'Remove Release 77, not in this track from Fixed in',
      }),
    ).toHaveFocus();
    await user.click(
      within(form).getByRole('button', { name: 'Remove Checkout from Owning area' }),
    );
    expect(within(form).getByText('None: saving leaves this field empty.')).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults).toEqual({
      targetReleaseIds: [42],
      fields: { '12': [41, 77], '99': 'kept' },
    });
  });

  it('[CORE-029] a draft of a template with release and area values saves as it was', () => {
    const fields = TEMPLATE_OPTIONS.fields;
    const body = bodyOf(draftOf(HOTFIX_TEMPLATE, fields), HOTFIX_TEMPLATE, fields, 'SHOP');
    expect(body.defaults).toEqual(HOTFIX_TEMPLATE.defaults);
  });

  it('passes every string through the pseudo-locale', async () => {
    const { form } = renderForm(HOTFIX_TEMPLATE, {
      locale: 'en-XA',
      refuse: { 'defaults.fields.12': 'archived', 'defaults.fields.13': 'track_only' },
    });
    await userEvent.click(form.querySelector('button[type="submit"]') as HTMLElement);
    await within(form).findByRole('alert');
    const data = [
      'Hotfix',
      'A fix shipped on its own',
      'Bug',
      'Chore',
      'Subticket',
      'Checklist item',
      'High',
      'Low',
      'Checkout',
      '1.0',
      '0.9',
      'Severity',
      'Customer',
      'Fixed in',
      'Owning area',
    ];
    const texts = visibleTexts(form).filter(
      (t) => !data.includes(t) && !data.some((d) => t === `[${d}]`),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

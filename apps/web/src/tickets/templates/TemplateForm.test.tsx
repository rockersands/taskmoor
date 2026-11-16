import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import type { FieldRule, SavedTemplate, TemplateClient, TemplateOptions } from './client';
import {
  bodyOf,
  clearedRefusal,
  draftOf,
  editedSpots,
  foundByEach,
  personSearchOf,
  saveRefusalOf,
} from './draft';
import {
  EVERY_TRACK_OPTIONS,
  fakeTemplateClient,
  HOTFIX_TEMPLATE,
  PEOPLE_TEMPLATE,
  RELEASE_TEMPLATE,
  RESTRICTED_RULES,
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
    names = undefined as TemplateClient['names'] | undefined,
    rules = {} as Record<string, FieldRule[]>,
  } = {},
) {
  const client = fakeTemplateClient(template ? [template] : [], { options, refuse, rules });
  if (names) client.names = names;
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
      /^Add one of the track’s open ones, or remove one/,
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
    // Every track has no releases of its own to name it by, nor to add from.
    expect(within(list).getByText('Release 41, not in this track')).toBeVisible();
    expect(list).toHaveAccessibleDescription(/^Set through the API\./);
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

  it('[CORE-029] reads ids in the API’s object form, and a save after a name change keeps them', async () => {
    const user = userEvent.setup();
    const template: SavedTemplate = {
      ...HOTFIX_TEMPLATE,
      defaults: { fields: { '12': [{ id: 41 }, 42], '13': { id: 31 }, '99': 'kept' } },
    };
    const { client, form } = renderForm(template);
    const fixedIn = within(form).getByRole('list', { name: 'Fixed in' });
    expect(
      within(fixedIn)
        .getAllByRole('listitem')
        .map((li) => li.firstChild?.textContent),
    ).toEqual(['1.0', '0.9 (archived)']);
    expect(
      within(within(form).getByRole('list', { name: 'Owning area' })).getByText('Checkout'),
    ).toBeVisible();
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Hotfix now');
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.fields).toEqual({
      '12': [41, 42],
      '13': 31,
      '99': 'kept',
    });
  });

  it('[CORE-029] keeps a value it cannot read whole as saved, and counts it', () => {
    const fields = TEMPLATE_OPTIONS.fields;
    const template: SavedTemplate = {
      ...HOTFIX_TEMPLATE,
      defaults: { fields: { '12': [41, { key: 'x' }], '13': 'Checkout', '99': 'kept' } },
    };
    renderForm(template);
    expect(
      screen.getByText('3 values of fields this form cannot show stay as they are.'),
    ).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Fixed in' })).toBeNull();
    const body = bodyOf(draftOf(template, fields), template, fields, 'SHOP');
    expect(body.defaults.fields).toEqual(template.defaults.fields);
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
      'Payments',
      '1.0',
      '0.9',
      '1.1',
      'Severity',
      'Customer',
      'Fixed in',
      'Owning area',
      // Offered to add (T-350).
      'Reviewer',
      'Owners',
      'Squad',
    ];
    const texts = visibleTexts(form).filter(
      (t) => !data.includes(t) && !data.some((d) => t === `[${d}]`),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('the ticket template form adds custom release and area values (CORE-029, T-299)', () => {
  it('[CORE-029] [CORE-015] [CORE-016] offers the track’s open releases and areas it does not hold, as the create form does', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(HOTFIX_TEMPLATE);
    const add = within(form).getByRole('combobox', { name: 'Release to add to Fixed in' });
    // 1.0 is held already and 0.9 is archived: only 1.1 is offered.
    expect(
      within(add)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None', '1.1']);
    const button = within(form).getByRole('button', { name: 'Add to Fixed in' });
    expect(button).toBeDisabled();
    await user.selectOptions(add, '1.1');
    await user.click(button);
    const fixedIn = within(form).getByRole('list', { name: 'Fixed in' });
    expect(within(fixedIn).getByText('1.1')).toBeVisible();
    // Nothing is left to add: the list goes, and the new value's Remove takes the focus.
    expect(within(form).queryByRole('combobox', { name: 'Release to add to Fixed in' })).toBeNull();
    expect(within(form).getByRole('button', { name: 'Remove 1.1 from Fixed in' })).toHaveFocus();
    // A field that holds one offers another once its value is removed.
    expect(within(form).queryByRole('combobox', { name: 'Area to add to Owning area' })).toBeNull();
    await user.click(
      within(form).getByRole('button', { name: 'Remove Checkout from Owning area' }),
    );
    const area = within(form).getByRole('combobox', { name: 'Area to add to Owning area' });
    expect(
      within(area)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None', 'Checkout', 'Payments']);
    await user.selectOptions(area, 'Payments');
    await user.click(within(form).getByRole('button', { name: 'Add to Owning area' }));
    expect(
      within(form).getByRole('button', { name: 'Remove Payments from Owning area' }),
    ).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.fields).toEqual({
      '12': [41, 42, 77, 43],
      '13': 33,
      '99': 'kept',
    });
  });

  it('[CORE-029] adds a custom release field the template does not hold yet, in a track only', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(RELEASE_TEMPLATE);
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Add a value for a field' }),
      'Fixed in',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the field' }));
    expect(within(form).getByText('None: saving leaves this field empty.')).toBeVisible();
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Release to add to Fixed in' }),
      '1.0',
    );
    await user.click(within(form).getByRole('button', { name: 'Add to Fixed in' }));
    // The list keeps the focus while there is more to add.
    expect(
      within(form).getByRole('combobox', { name: 'Release to add to Fixed in' }),
    ).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.fields).toEqual({ '7': 70, '12': [41], '99': 'kept' });
    cleanup();
    // A template for every track has no releases or areas to choose from.
    const every = renderForm(null, { options: EVERY_TRACK_OPTIONS, track: null });
    const fields = within(
      within(every.form).getByRole('combobox', { name: 'Add a value for a field' }),
    )
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Person, group and team fields are found in the whole site (T-350).
    expect(fields).toEqual(['None', 'Severity', 'Customer', 'Reviewer', 'Owners', 'Squad']);
  });

  it('[CORE-029] says when the track has no open area to add', () => {
    const options: TemplateOptions = {
      ...TEMPLATE_OPTIONS,
      areas: [{ id: 32, name: 'Old storefront', archived: true }],
    };
    const template: SavedTemplate = { ...HOTFIX_TEMPLATE, defaults: { fields: { '13': 32 } } };
    const { form } = renderForm(template, { options });
    expect(within(form).getByText('This track has no areas to choose.')).toBeVisible();
    expect(within(form).queryByRole('combobox', { name: 'Area to add to Owning area' })).toBeNull();
  });
});

describe('the ticket template form names custom person, group and team values (CORE-029, T-299)', () => {
  it('[CORE-029] [CORE-009] names them as the create form’s pickers do, one it may not name by its number', async () => {
    const { form } = renderForm(PEOPLE_TEMPLATE);
    // The names are read first.
    expect(within(form).getAllByText('Reading the names…')).toHaveLength(3);
    const reviewer = await within(form).findByRole('list', { name: 'Reviewer' });
    expect(within(reviewer).getByText('Sam Rivera')).toBeVisible();
    const owners = within(form).getByRole('list', { name: 'Owners' });
    expect(
      within(owners)
        .getAllByRole('listitem')
        .map((li) => li.firstChild?.textContent),
    ).toEqual(['Support', 'Group 52, hidden from you or gone']);
    expect(owners).toHaveAccessibleDescription(/^Find one to add, or remove one/);
    expect(
      within(within(form).getByRole('list', { name: 'Squad' })).getByText('Checkout squad'),
    ).toBeVisible();
    // None is only counted any more; they are found with a search, not picked from a list.
    expect(within(form).queryByText(/this form cannot show/)).toBeNull();
    expect(within(form).queryByRole('button', { name: /^Add to / })).toBeNull();
  });

  it('[CORE-029] removes one and saves the rest, the hidden one too', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(PEOPLE_TEMPLATE);
    await user.click(
      await within(form).findByRole('button', { name: 'Remove Support from Owners' }),
    );
    expect(
      within(form).getByRole('button', {
        name: 'Remove Group 52, hidden from you or gone from Owners',
      }),
    ).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Remove Sam Rivera from Reviewer' }));
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.fields).toEqual({ '15': [52], '16': 61 });
    // Saved untouched, the values stay as they were.
    const fields = TEMPLATE_OPTIONS.fields;
    const body = bodyOf(draftOf(PEOPLE_TEMPLATE, fields), PEOPLE_TEMPLATE, fields, 'SHOP');
    expect(body.defaults).toEqual(PEOPLE_TEMPLATE.defaults);
  });

  it('[CORE-029] names each by its number when the names cannot be read', async () => {
    const { form } = renderForm(PEOPLE_TEMPLATE, {
      names: async () => {
        throw new ApiError(503, { error: 'unavailable' });
      },
    });
    const reviewer = await within(form).findByRole('list', { name: 'Reviewer' });
    expect(within(reviewer).getByText('Person 21, hidden from you or gone')).toBeVisible();
    expect(within(form).getByText('Team 61, gone')).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const { form } = renderForm(PEOPLE_TEMPLATE, { locale: 'en-XA' });
    await within(form).findByText('Support');
    const data = [
      'Review',
      'A change someone reviews',
      'Sam Rivera',
      'Support',
      'Checkout squad',
      ...TEMPLATE_OPTIONS.fields.map((f) => f.name),
      ...TEMPLATE_OPTIONS.types.map((f) => f.name),
      ...TEMPLATE_OPTIONS.priorities.map((f) => f.name),
      ...TEMPLATE_OPTIONS.areas.map((f) => f.name),
      ...TEMPLATE_OPTIONS.releases.map((f) => f.name),
    ];
    const texts = visibleTexts(form).filter((t) => !data.some((d) => t === d || t === `[${d}]`));
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('a refused value’s reason clears when it is edited (CORE-029, T-299)', () => {
  it('[CORE-029] clears the reason under the edited value, and the form’s line with the last one', async () => {
    const user = userEvent.setup();
    const { form } = renderForm(RELEASE_TEMPLATE, {
      refuse: {
        'defaults.priorityId': 'not_found',
        'defaults.fields.7': 'not_in_track',
        'subtickets.1.summary': 'too_long',
      },
    });
    await save(form);
    const priority = within(form).getByRole('combobox', { name: 'Priority' });
    await user.selectOptions(priority, 'Low');
    expect(priority).not.toHaveAttribute('aria-invalid');
    expect(priority).not.toHaveAccessibleDescription();
    // The others keep theirs, and the line says to look under them.
    const severity = within(form).getByRole('combobox', { name: 'Severity' });
    expect(severity).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByRole('alert')).toHaveTextContent('The reason is under each of them.');
    await waitFor(() =>
      expect(within(severity).getByRole('option', { name: 'Minor' })).toBeInTheDocument(),
    );
    await user.selectOptions(severity, 'Minor');
    expect(severity).not.toHaveAttribute('aria-invalid');
    const second = within(form).getByRole('textbox', { name: 'Subticket 2: summary' });
    await user.type(second, '!');
    expect(second).not.toHaveAttribute('aria-invalid');
    expect(within(form).queryByRole('alert')).toBeNull();
  });

  it('[CORE-029] clears a custom release field’s reason when one is removed, and a name in use when the name changes', async () => {
    const user = userEvent.setup();
    const { form } = renderForm(HOTFIX_TEMPLATE, { refuse: { 'defaults.fields.12': 'archived' } });
    await save(form);
    const fixedIn = within(form).getByRole('list', { name: 'Fixed in' });
    expect(fixedIn).toHaveAccessibleDescription(/archived\. Choose another\.$/);
    await user.click(
      within(form).getByRole('button', { name: 'Remove 0.9 (archived) from Fixed in' }),
    );
    expect(fixedIn).not.toHaveAccessibleDescription(/archived/);
    expect(within(form).queryByRole('alert')).toBeNull();
    cleanup();
    const taken = renderForm(RELEASE_TEMPLATE, { refuse: { name: 'taken' } });
    expect(await save(taken.form)).toHaveTextContent(
      'Another template here already has that name.',
    );
    await user.type(within(taken.form).getByRole('textbox', { name: 'Name' }), ' 2');
    expect(within(taken.form).queryByRole('alert')).toBeNull();
  });

  it('[CORE-029] keeps the general line while a problem it could not place stays', async () => {
    const user = userEvent.setup();
    const { form } = renderForm(RELEASE_TEMPLATE, {
      refuse: { 'defaults.fields.99': 'read_only', 'defaults.priorityId': 'not_found' },
    });
    await save(form);
    const priority = within(form).getByRole('combobox', { name: 'Priority' });
    await user.selectOptions(priority, 'Low');
    expect(priority).not.toHaveAttribute('aria-invalid');
    // The formula field's value has no place on the form: its line stays.
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Some values cannot be used. Check the days, the fields and the subtickets.',
    );
    const draft = draftOf(RELEASE_TEMPLATE, TEMPLATE_OPTIONS.fields);
    const refusal = saveRefusalOf(
      new ApiError(400, {
        error: 'invalid_fields',
        fields: { 'defaults.fields.99': 'read_only', 'defaults.priorityId': 'not_found' },
      }),
      draft,
    );
    expect(editedSpots(draft, { ...draft, priorityId: '2' })).toEqual(['priority']);
    // An edit elsewhere leaves the refusal as it was.
    expect(clearedRefusal(refusal, editedSpots(draft, { ...draft, labels: 'x' }))).toBe(refusal);
    const first = draft.subtickets[0] ?? { summary: '', ticketTypeId: '' };
    expect(
      editedSpots(draft, {
        ...draft,
        fields: { ...draft.fields, '7': '71' },
        subtickets: [first, { summary: 'B', ticketTypeId: '5' }],
      }),
    ).toEqual(['field:7', 'subticket:1', 'subticket:1:type']);
  });
});

/** Types into a picker's search field; the picker around it, to read what it offers. */
async function search(form: HTMLElement, name: string, typed: string) {
  const user = userEvent.setup();
  const input = within(form).getByRole('searchbox', { name });
  await user.clear(input);
  await user.type(input, typed);
  return input.closest('.person-picker') as HTMLElement;
}

/** What a picker offers, by name. */
const offeredIn = (picker: HTMLElement) =>
  within(picker)
    .queryAllByRole('listitem')
    .map((li) => li.textContent);

describe('the ticket template form adds custom person, group and team values (CORE-029, T-350)', () => {
  it('[CORE-029] [CORE-009] finds people, groups and teams as the create form does, and saves them', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(PEOPLE_TEMPLATE);
    // A field that holds one person offers a search once that person is removed.
    await within(form).findByRole('list', { name: 'Reviewer' });
    expect(within(form).queryByRole('searchbox', { name: 'Person to add to Reviewer' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Remove Sam Rivera from Reviewer' }));
    // As for a release or area, the focus goes to the line saying it holds none (T-299).
    expect(within(form).getByText('None: saving leaves this field empty.')).toHaveFocus();
    expect(
      within(form).getByRole('searchbox', { name: 'Person to add to Reviewer' }),
    ).toBeVisible();
    const reviewer = await search(form, 'Person to add to Reviewer', 'an');
    await waitFor(() => expect(offeredIn(reviewer)).toEqual(['Ana Ortiz']));
    expect(client.searched).toContain('people:SHOP:an');
    await user.click(within(form).getByRole('button', { name: 'Ana Ortiz' }));
    // The search gives way to the one person, whose Remove takes the focus.
    expect(within(form).queryByRole('searchbox', { name: 'Person to add to Reviewer' })).toBeNull();
    expect(
      within(form).getByRole('button', { name: 'Remove Ana Ortiz from Reviewer' }),
    ).toHaveFocus();

    // A field that holds several keeps its search, and never offers what it holds.
    const owners = await search(form, 'Group to add to Owners', 's');
    await waitFor(() => expect(offeredIn(owners)).toEqual(['Design', 'Sales']));
    expect(client.searched).toContain('groups:15:s');
    await user.click(within(form).getByRole('button', { name: 'Sales' }));
    expect(within(form).getByRole('searchbox', { name: 'Group to add to Owners' })).toHaveFocus();
    expect(
      within(within(form).getByRole('list', { name: 'Owners' }))
        .getAllByRole('listitem')
        .map((li) => li.firstChild?.textContent),
    ).toEqual(['Support', 'Group 52, hidden from you or gone', 'Sales']);

    await user.click(
      within(form).getByRole('button', { name: 'Remove Checkout squad from Squad' }),
    );
    const squad = await search(form, 'Team to add to Squad', 'squad');
    await waitFor(() => expect(offeredIn(squad)).toEqual(['Checkout squad', 'Search squad']));
    expect(client.searched).toContain('teams:squad');
    await user.click(within(form).getByRole('button', { name: 'Search squad' }));

    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.fields).toEqual({
      '14': 22,
      '15': [51, 52, 54],
      '16': 62,
    });
  });

  it('[CORE-029] adds a person, group or team field a new template does not hold yet', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(null);
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Review');
    const add = within(form).getByRole('combobox', { name: 'Add a value for a field' });
    expect(
      within(add)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'None',
      'Severity',
      'Customer',
      'Fixed in',
      'Owning area',
      'Reviewer',
      'Owners',
      'Squad',
    ]);
    await user.selectOptions(add, 'Owners');
    await user.click(within(form).getByRole('button', { name: 'Add the field' }));
    expect(within(form).getByText('None: saving leaves this field empty.')).toBeVisible();
    const owners = await search(form, 'Group to add to Owners', 'de');
    await waitFor(() => expect(offeredIn(owners)).toEqual(['Design']));
    await user.click(within(form).getByRole('button', { name: 'Design' }));
    expect(
      within(within(form).getByRole('list', { name: 'Owners' })).getByText('Design'),
    ).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.fields).toEqual({ '15': [53] });
  });

  it('[CORE-029] [CORE-009] offers only the people a restricted field allows for every type the template fits', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(null, { rules: { '14': RESTRICTED_RULES } });
    await user.click(within(form).getByRole('checkbox', { name: 'Bug' }));
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Add a value for a field' }),
      'Reviewer',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the field' }));
    const input = await within(form).findByRole('searchbox', {
      name: 'Person to add to Reviewer',
    });
    expect(input).toHaveAccessibleDescription(
      'Type a name. Only the people this field allows are offered.',
    );
    // Bugs allow Sam and Ana.
    const reviewer = await search(form, 'Person to add to Reviewer', 'a');
    await waitFor(() => expect(offeredIn(reviewer)).toEqual(['Sam Rivera', 'Ana Ortiz']));
    expect(client.searched).toEqual(['fieldPeople:14:SHOP:3:a']);
    // Chores allow Ana and Lee: a template for both offers only Ana, whom both allow.
    await user.click(within(form).getByRole('checkbox', { name: 'Chore' }));
    client.searched.length = 0;
    await search(form, 'Person to add to Reviewer', 'a');
    await waitFor(() => expect(offeredIn(reviewer)).toEqual(['Ana Ortiz']));
    expect([...client.searched].sort()).toEqual([
      'fieldPeople:14:SHOP:3:a',
      'fieldPeople:14:SHOP:4:a',
    ]);
    // A template for every type fits them all: the subticket types' context allows anyone, so
    // Bugs and Chores still limit it.
    await user.click(within(form).getByRole('checkbox', { name: 'Bug' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Chore' }));
    client.searched.length = 0;
    await search(form, 'Person to add to Reviewer', 'a');
    await waitFor(() => expect(offeredIn(reviewer)).toEqual(['Ana Ortiz']));
    expect(client.searched).toHaveLength(2);
  });

  it('[CORE-029] finds people in the whole site for a template for every track, unless the field allows only some', async () => {
    const user = userEvent.setup();
    const every = renderForm(null, { options: EVERY_TRACK_OPTIONS, track: null });
    await user.selectOptions(
      within(every.form).getByRole('combobox', { name: 'Add a value for a field' }),
      'Reviewer',
    );
    await user.click(within(every.form).getByRole('button', { name: 'Add the field' }));
    await within(every.form).findByRole('searchbox', { name: 'Person to add to Reviewer' });
    const reviewer = await search(every.form, 'Person to add to Reviewer', 'kim');
    await waitFor(() => expect(offeredIn(reviewer)).toEqual(['Kim Alvarez']));
    expect(every.client.searched).toEqual(['sitePeople:kim']);
    cleanup();

    // Whom a restricted field allows is known per track and type: no search can say it here.
    const restricted = renderForm(
      { ...PEOPLE_TEMPLATE, track: null },
      { options: EVERY_TRACK_OPTIONS, track: null, rules: { '14': RESTRICTED_RULES } },
    );
    await user.click(
      await within(restricted.form).findByRole('button', {
        name: 'Remove Sam Rivera from Reviewer',
      }),
    );
    expect(
      await within(restricted.form).findByText(
        /^This field allows only some people, and who depends on the track/,
      ),
    ).toBeVisible();
    expect(
      within(restricted.form).queryByRole('searchbox', { name: 'Person to add to Reviewer' }),
    ).toBeNull();
    // Groups and teams are the site's anywhere.
    expect(
      within(restricted.form).getByRole('searchbox', { name: 'Group to add to Owners' }),
    ).toBeVisible();
  });

  it('[CORE-029] offers no person search when the field’s contexts cannot be read', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(null);
    client.fieldRules = async () => {
      throw new ApiError(503, { error: 'unavailable' });
    };
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Add a value for a field' }),
      'Reviewer',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the field' }));
    expect(await within(form).findByText(/^Set through the API\./)).toBeVisible();
    expect(within(form).queryByRole('searchbox', { name: 'Person to add to Reviewer' })).toBeNull();
  });

  it('[CORE-009] reads a field’s context for a type and track as the server picks it', () => {
    const rules: FieldRule[] = [
      { id: 1, trackIds: null, ticketTypeIds: null, restricted: true },
      { id: 2, trackIds: [1], ticketTypeIds: null, restricted: false },
      { id: 3, trackIds: null, ticketTypeIds: [4], restricted: true },
      { id: 4, trackIds: [1], ticketTypeIds: [5], restricted: true },
    ];
    // In track 1, the track's own context wins over the type's in every track, and the one
    // naming both wins over the track's.
    expect(personSearchOf(rules, 1, [3, 4])).toEqual({ kind: 'anyone' });
    expect(personSearchOf(rules, 1, [3, 5])).toEqual({ kind: 'allowed', typeIds: [5] });
    // Elsewhere, the type's context, then the one for everything; one type is asked per context.
    expect(personSearchOf(rules, 2, [4, 6, 7])).toEqual({ kind: 'allowed', typeIds: [4, 6] });
    // A field no context covers here leaves the track's search as it is.
    expect(personSearchOf([rules[3] as FieldRule], 2, [5])).toEqual({ kind: 'anyone' });
    expect(personSearchOf(rules, null, [])).toEqual({ kind: 'none' });
    expect(personSearchOf([rules[1] as FieldRule], null, [])).toEqual({ kind: 'anyone' });
    const a = { id: 1, name: 'A' };
    const b = { id: 2, name: 'B' };
    expect(foundByEach([[a, b], [b]])).toEqual([b]);
    expect(foundByEach([])).toEqual([]);
  });

  it('passes every string through the pseudo-locale while searching', async () => {
    const { form } = renderForm(PEOPLE_TEMPLATE, { locale: 'en-XA' });
    await within(form).findByText('Support');
    // The search of Owners, the one field here that holds several.
    const input = form.querySelector('.ticket-template-find input') as HTMLElement;
    await userEvent.type(input, 'zzz');
    const picker = input.closest('.person-picker') as HTMLElement;
    await waitFor(() => expect(within(picker).getByRole('status')).not.toHaveTextContent(''));
    const data = [
      'Review',
      'A change someone reviews',
      'Sam Rivera',
      'Support',
      'Checkout squad',
      ...TEMPLATE_OPTIONS.fields.map((f) => f.name),
      ...TEMPLATE_OPTIONS.types.map((f) => f.name),
      ...TEMPLATE_OPTIONS.priorities.map((f) => f.name),
      ...TEMPLATE_OPTIONS.areas.map((f) => f.name),
      ...TEMPLATE_OPTIONS.releases.map((f) => f.name),
    ];
    const texts = visibleTexts(form).filter((t) => !data.some((d) => t === d || t === `[${d}]`));
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('the ticket template form’s assignee (CORE-029, T-269, T-283)', () => {
  it('[CORE-029] [CORE-008] finds the assignee among those who may be given tickets in the track', async () => {
    const user = userEvent.setup();
    const { client, form } = renderForm(null);
    await user.type(within(form).getByRole('searchbox', { name: 'Assignee' }), 'an');
    await within(form).findByRole('button', { name: 'Ana Ortiz' });
    expect(client.searched).toEqual(['assignable:SHOP:an']);
  });

  it('[CORE-029] [IAM-009] shows an assignee it may not name by number, and keeps it on save', async () => {
    const user = userEvent.setup();
    const hidden: SavedTemplate = { ...RELEASE_TEMPLATE, assignee: null };
    const { client, form } = renderForm(hidden);
    const assignee = within(form).getByRole('list', { name: 'Assignee' });
    expect(within(assignee).getByText('Person 21, hidden from you or gone')).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await waitFor(() => expect(client.saved).toHaveLength(1));
    expect(client.saved[0]?.body.defaults.assigneeId).toBe(21);
    // Removed, it goes from the draft, and the assignee search takes its place.
    cleanup();
    const removed = renderForm(hidden);
    await user.click(
      within(removed.form).getByRole('button', {
        name: 'Remove Person 21, hidden from you or gone as assignee',
      }),
    );
    expect(within(removed.form).getByRole('searchbox', { name: 'Assignee' })).toBeVisible();
    const fields = TEMPLATE_OPTIONS.fields;
    const draft = { ...draftOf(hidden, fields), assignee: null };
    expect(bodyOf(draft, hidden, fields, 'SHOP').defaults.assigneeId).toBeUndefined();
    expect(bodyOf(draftOf(hidden, fields), hidden, fields, 'SHOP').defaults.assigneeId).toBe(21);
  });
});

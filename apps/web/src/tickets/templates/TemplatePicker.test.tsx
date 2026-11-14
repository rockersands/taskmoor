import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { type CreateClient, CreateTicketPage } from '../CreateTicketPage';
import { BUG_FORM, CHORE_FORM, PRIORITIES, TRACKS, TYPES } from '../fixtures';
import type { TicketForm } from '../form';
import { type FakePickerClient, fakePickerClient } from './fixtures';

function renderForm(
  picker: FakePickerClient = fakePickerClient(),
  locale: 'en' | 'en-XA' = 'en',
  more: Partial<CreateClient> = {},
) {
  const created: Record<string, unknown>[] = [];
  const client: CreateClient = {
    tracks: async () => TRACKS,
    ticketTypes: async () => ({ defaultTypeId: 3, types: TYPES }),
    form: async (_track, typeId) => (typeId === 3 ? BUG_FORM : CHORE_FORM),
    priorities: async () => PRIORITIES,
    create: async (body) => {
      created.push(body);
      return { key: 'SHOP-1' };
    },
    ticketTemplates: picker,
    ...more,
  };
  render(
    <I18nProvider locale={locale}>
      <main>
        <CreateTicketPage client={client} ai={{ features: async () => ({}) as never }} />
      </main>
    </I18nProvider>,
  );
  return { created, picker };
}

/** The bug form with the areas and target releases on it, which have pickers. */
const PICKER_FORM: TicketForm = {
  ...BUG_FORM,
  layout: {
    ...BUG_FORM.layout,
    tabs: BUG_FORM.layout.tabs.map((tab, i) =>
      i === 0
        ? {
            ...tab,
            sections: [
              ...tab.sections,
              {
                kind: 'main',
                hideWhenEmpty: false,
                fields: [
                  { key: 'area', required: false, description: null },
                  { key: 'targetRelease', required: false, description: null },
                ],
              },
            ],
          }
        : tab,
    ),
  },
};

/** The bug form with custom person, group, team, release and area fields on it (T-276). */
const CUSTOM_PICKER_FORM: TicketForm = {
  ...BUG_FORM,
  layout: {
    ...BUG_FORM.layout,
    tabs: BUG_FORM.layout.tabs.map((tab, i) =>
      i === 0
        ? {
            ...tab,
            sections: [
              ...tab.sections,
              {
                kind: 'main',
                hideWhenEmpty: false,
                fields: [61, 62, 63, 64, 65, 66].map((id) => ({
                  key: `cf[${id}]`,
                  required: false,
                  description: null,
                })),
              },
            ],
          }
        : tab,
    ),
  },
  customFields: [
    ...BUG_FORM.customFields,
    { id: 61, name: 'Reviewer', description: '', type: 'user', multiple: false },
    { id: 62, name: 'Owning groups', description: '', type: 'group', multiple: true },
    { id: 63, name: 'Team', description: '', type: 'team', multiple: false },
    { id: 64, name: 'Fixed in', description: '', type: 'release', multiple: false },
    { id: 65, name: 'Parts', description: '', type: 'area', multiple: true },
    { id: 66, name: 'Watchers', description: '', type: 'user', multiple: true },
  ],
};

const pick = async (user: ReturnType<typeof userEvent.setup>, name = 'Release checklist') => {
  const picker = await screen.findByRole('combobox', { name: 'Start from a template' });
  await screen.findByLabelText('Summary (required)');
  await user.selectOptions(picker, name);
  await screen.findByText(`The values of ${name} are filled in: change what differs.`);
};

describe('starting a ticket from a template (CORE-030)', () => {
  it('[CORE-030] offers nothing when no template fits', async () => {
    renderForm(fakePickerClient([]));
    await screen.findByLabelText('Summary (required)');
    expect(screen.queryByRole('combobox', { name: 'Start from a template' })).toBeNull();
  });

  it('[CORE-030] fills the form for review and sends it with the template', async () => {
    const user = userEvent.setup();
    const { picker, created } = renderForm();
    await pick(user);
    expect(screen.getByText('Everything a release needs')).toBeVisible();
    expect(screen.getByLabelText('Summary (required)')).toHaveValue('Release SHOP 2026-11-03');
    expect(screen.getByLabelText('Due date (required)')).toHaveValue('2026-11-10');
    expect(screen.getByLabelText('Severity (required)')).toHaveValue('70');
    const also = screen.getByRole('group', { name: 'Also from this template' });
    expect(within(also).getByRole('checkbox', { name: 'Assignee' })).toBeChecked();
    expect(within(also).getByRole('checkbox', { name: 'Create its 2 subtickets' })).toBeChecked();
    await user.clear(screen.getByLabelText('Summary (required)'));
    await user.type(screen.getByLabelText('Summary (required)'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeInTheDocument();
    expect(screen.getByText('Subtickets created: SHOP-10, SHOP-11.')).toBeVisible();
    expect(created).toEqual([]);
    expect(picker.applied[0]?.id).toBe(11);
    expect(picker.applied[0]?.body).toMatchObject({
      track: 'SHOP',
      ticketTypeId: 3,
      summary: 'Mine',
      dueDate: '2026-11-10',
      fields: { 7: 70 },
      omit: [],
      subtickets: true,
    });
    // The form is empty again, and the next ticket starts from nothing.
    expect(screen.getByLabelText('Summary (required)')).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Start from a template' })).toHaveValue('');
  });

  it('[CORE-030] leaves out what the person turned off', async () => {
    const user = userEvent.setup();
    const { picker } = renderForm();
    await pick(user);
    await user.click(screen.getByRole('checkbox', { name: 'Assignee' }));
    await user.click(screen.getByRole('checkbox', { name: 'Create its 2 subtickets' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('SHOP-9 was created.');
    const body = picker.applied[0]?.body as Record<string, unknown>;
    expect(body.omit).toEqual(['assigneeId']);
    expect(body.subtickets).toBe(false);
  });

  it('[CORE-030] fills the pickers with its assignee, releases and areas; the form’s choice wins (T-265)', async () => {
    const user = userEvent.setup();
    const picker = fakePickerClient(undefined, {
      summary: 'Release SHOP 2026-11-03',
      assigneeId: 21,
      areaIds: [31],
      targetReleaseIds: [41],
      dueDate: '2026-11-10',
      fields: { '7': 70 },
    });
    renderForm(picker, 'en', {
      form: async () => PICKER_FORM,
      assignable: async () => [{ id: 22, name: 'Sasha Lee' }],
      areas: async () => [
        { id: 31, name: 'Checkout' },
        { id: 32, name: 'Search' },
      ],
      releases: async () => [{ id: 41, name: '1.0' }],
    });
    await pick(user);
    // In the pickers, not in the list of what the form cannot show.
    expect(screen.getByRole('list', { name: 'Assignee' })).toHaveTextContent('Sam Rivera');
    expect(await screen.findByRole('checkbox', { name: 'Checkout' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: '1.0' })).toBeChecked();
    const also = screen.getByRole('group', { name: 'Also from this template' });
    expect(within(also).queryByRole('checkbox', { name: 'Assignee' })).toBeNull();
    // Another assignee chosen in the form takes the template's place; a cleared area is left out.
    await user.click(screen.getByRole('button', { name: 'Remove Sam Rivera' }));
    await user.type(screen.getByRole('searchbox', { name: 'Assignee' }), 'sa');
    await user.click(await screen.findByRole('button', { name: 'Sasha Lee' }));
    await user.click(screen.getByRole('checkbox', { name: 'Checkout' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeInTheDocument();
    const body = picker.applied[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ assigneeId: 22, targetReleaseIds: [41] });
    expect(body.areaIds).toBeUndefined();
    expect(body.omit).toEqual(['areaIds']);
  });

  it('[CORE-030] keeps a release the picker does not offer in the list, where it can be turned off (T-265)', async () => {
    const user = userEvent.setup();
    // Release 1.0 (41) was archived after the template was saved: the track offers only 1.1.
    const picker = fakePickerClient(undefined, {
      summary: 'Release SHOP 2026-11-03',
      areaIds: [31],
      targetReleaseIds: [41],
      dueDate: '2026-11-10',
      fields: { '7': 70 },
    });
    renderForm(picker, 'en', {
      form: async () => PICKER_FORM,
      areas: async () => [{ id: 31, name: 'Checkout' }],
      releases: async () => [{ id: 42, name: '1.1' }],
    });
    await screen.findByRole('checkbox', { name: '1.1' });
    await pick(user);
    // The offered area fills its picker; the archived release is named with a checkbox.
    expect(screen.getByRole('checkbox', { name: 'Checkout' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '1.1' })).not.toBeChecked();
    const also = screen.getByRole('group', { name: 'Also from this template' });
    const release = within(also).getByRole('checkbox', { name: 'Target releases' });
    expect(release).toBeChecked();
    // Turned off there, it is left out, and a release ticked in the form is sent instead.
    await user.click(release);
    await user.click(screen.getByRole('checkbox', { name: '1.1' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeInTheDocument();
    const body = picker.applied[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ areaIds: [31], targetReleaseIds: [42] });
    expect(body.omit).toEqual(['targetReleaseIds']);
  });

  it('[CORE-030] fills its custom people, groups, teams, releases and areas into the pickers; the form’s choice wins (T-276)', async () => {
    const user = userEvent.setup();
    const picker = fakePickerClient(
      undefined,
      {
        summary: 'Release SHOP 2026-11-03',
        dueDate: '2026-11-10',
        fields: { '7': 70, '61': 21, '62': [41], '63': 51, '64': 5, '65': [7], '66': [21, 99] },
      },
      {},
      {
        'fields.61': [{ id: 21, name: 'Sam Rivera' }],
        'fields.62': [{ id: 41, name: 'Operations' }],
        'fields.63': [{ id: 51, name: 'Payments' }],
        // Person 99 is someone this reader may not see: the template start leaves them unnamed.
        'fields.66': [{ id: 21, name: 'Sam Rivera' }],
      },
    );
    renderForm(picker, 'en', {
      form: async () => CUSTOM_PICKER_FORM,
      people: async () => [{ id: 22, name: 'Sasha Lee' }],
      groups: async () => [{ id: 42, name: 'Ops leads' }],
      teams: async () => [{ id: 52, name: 'Search' }],
      releases: async () => [{ id: 5, name: 'Spring' }],
      areas: async () => [
        { id: 7, name: 'Checkout' },
        { id: 8, name: 'Search' },
      ],
    });
    await screen.findByRole('option', { name: 'Spring' });
    await pick(user);
    // In the pickers, by name, not in the list of what the form cannot show.
    expect(screen.getByRole('list', { name: 'Reviewer' })).toHaveTextContent('Sam Rivera');
    expect(screen.getByRole('list', { name: 'Owning groups' })).toHaveTextContent('Operations');
    expect(screen.getByRole('list', { name: 'Team' })).toHaveTextContent('Payments');
    expect(screen.getByRole('combobox', { name: 'Fixed in' })).toHaveValue('5');
    expect(screen.getByRole('checkbox', { name: 'Checkout' })).toBeChecked();
    const also = screen.getByRole('group', { name: 'Also from this template' });
    for (const name of ['Reviewer', 'Owning groups', 'Team', 'Fixed in', 'Parts']) {
      expect(within(also).queryByRole('checkbox', { name })).toBeNull();
    }
    // One of its watchers has no name for this person: the field stays in the list, unnamed
    // there too, and the picker is left empty.
    expect(within(also).getByRole('checkbox', { name: 'Watchers' })).toBeChecked();
    expect(screen.queryByRole('list', { name: 'Watchers' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Watchers' })).toHaveValue('');
    // Another reviewer chosen in the form wins; the group cleared there is left out.
    await user.click(screen.getByRole('button', { name: 'Remove Sam Rivera' }));
    await user.type(screen.getByRole('searchbox', { name: 'Reviewer' }), 'sa');
    await user.click(await screen.findByRole('button', { name: 'Sasha Lee' }));
    await user.click(screen.getByRole('button', { name: 'Remove Operations' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeInTheDocument();
    const body = picker.applied[0]?.body as Record<string, unknown>;
    expect(body.fields).toEqual({ 7: 70, 61: 22, 63: 51, 64: 5, 65: [7] });
    expect(body.omit).toEqual(['fields.62']);
  });

  it('[CORE-030] says what was left out and which subtickets failed', async () => {
    const user = userEvent.setup();
    renderForm(
      fakePickerClient(undefined, undefined, {
        left: ['assigneeId', 'fields.7', 'fields.55'],
        subtickets: [{ summary: 'Announce it', key: null, error: 'refused' }],
      }),
    );
    await pick(user);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText(
        'Left out, because they cannot be set here: Assignee, Severity, field 55.',
      ),
    ).toBeVisible();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The ticket was created, but these subtickets could not be:');
    expect(within(alert).getByText('Announce it')).toBeVisible();
  });

  it('[CORE-030] a change of ticket type lets go of the template and keeps the words', async () => {
    const user = userEvent.setup();
    const { picker, created } = renderForm();
    await pick(user);
    await user.click(screen.getByRole('combobox', { name: 'Ticket type' }));
    await user.click(screen.getByRole('option', { name: 'Chore' }));
    await screen.findByRole('combobox', { name: 'Start from a template' });
    expect(screen.getByRole('combobox', { name: 'Start from a template' })).toHaveValue('');
    expect(screen.getByLabelText(/^Summary/)).toHaveValue('Release SHOP 2026-11-03');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('SHOP-1 was created.');
    expect(picker.applied).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it('[CORE-030] choosing no template clears what it filled in', async () => {
    const user = userEvent.setup();
    renderForm();
    await pick(user);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Start from a template' }),
      'No template',
    );
    expect(screen.getByLabelText('Summary (required)')).toHaveValue('');
    expect(screen.queryByRole('group', { name: 'Also from this template' })).toBeNull();
  });

  it('says when a template cannot be loaded', async () => {
    const user = userEvent.setup();
    const picker = fakePickerClient();
    picker.start = async () => {
      throw new Error('gone');
    };
    renderForm(picker);
    const select = await screen.findByRole('combobox', { name: 'Start from a template' });
    await screen.findByLabelText('Summary (required)');
    await user.selectOptions(select, 'Release checklist');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That template could not be loaded.',
    );
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderForm();
    await pick(user);
    expect(screen.getByRole('group', { name: 'Also from this template' })).toBeVisible();
  });

  it('passes the picker’s strings through the pseudo-locale', async () => {
    renderForm(fakePickerClient(), 'en-XA');
    const field = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.ticket-template-picker');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const texts = visibleTexts(field).filter((t) => t !== 'Release checklist');
    expect(untranslated(texts)).toEqual([]);
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { type CreateClient, CreateTicketPage } from '../CreateTicketPage';
import { BUG_FORM, CHORE_FORM, PRIORITIES, TRACKS, TYPES } from '../fixtures';
import { type FakePickerClient, fakePickerClient } from './fixtures';

function renderForm(picker: FakePickerClient = fakePickerClient(), locale: 'en' | 'en-XA' = 'en') {
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

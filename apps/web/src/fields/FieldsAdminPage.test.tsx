import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, CONFIG_ADMIN, TRACK_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { FieldsAdminPage } from './FieldsAdminPage';
import { CHECK_DELAY_MS } from './FormulaEditor';
import { fakeFieldsClient } from './fixtures';

function renderPage(locale: Locale = 'en', client = fakeFieldsClient()) {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADMIN}>
        <main>
          <FieldsAdminPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('field administration (M1-053, T-320)', () => {
  it('[CORE-009] adds a choice list, gives it options, renames, retires and deletes one', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await screen.findByText('Customer');
    const opener = screen.getByRole('button', { name: 'New field' });
    await user.click(opener);
    // Cancel closes the form and gives the focus back to New field (D11).
    await user.click(
      within(screen.getByRole('form', { name: 'Add a field' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(opener).toHaveFocus();
    await user.click(opener);
    const form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'Area of work');
    await user.selectOptions(within(form).getByLabelText('Type'), 'select');
    await user.click(within(form).getByLabelText('Holds several values'));
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(await screen.findByText('Area of work was added.')).toBeInTheDocument();
    expect(client.calls[0]).toEqual({
      action: 'createField',
      args: [{ name: 'Area of work', type: 'select', multiple: true }],
    });

    const add = await screen.findByRole('form', { name: 'Add an option to Default' });
    for (const value of ['North', 'South']) {
      await user.type(within(add).getByLabelText('New option'), value);
      await user.click(within(add).getByRole('button', { name: 'Add the option' }));
      expect(await screen.findByText(`${value} was added.`)).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Rename North' }));
    const input = screen.getByLabelText('New name for North');
    await user.clear(input);
    await user.type(input, 'North east');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The option is called North east now.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop offering South' }));
    expect(await screen.findByText('South is no longer offered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Offer again South' })).toBeVisible();
    // A plain unused option comes back by typing its name: it goes at once (D13, T-267).
    const deleting = screen.getByRole('button', { name: 'Delete North east' });
    expect(deleting).toHaveClass('button-secondary');
    await user.click(deleting);
    expect(screen.queryByRole('group', { name: /^Delete North east/ })).toBeNull();
    expect(await screen.findByText('North east was deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename North east' })).toBeNull();
  });

  it('[CORE-009] says how many tickets hold an option it may not delete', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Severity' }));
    // A plain option asks nothing first (T-267): the refusal comes at the first press.
    await user.click(await screen.findByRole('button', { name: 'Delete Medium' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '3 tickets hold it, the trash included. Stop offering it instead.',
    );
    // Refused: the option stays, and so does the keyboard.
    expect(screen.getByRole('button', { name: 'Delete Medium' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete field Severity' }));
    const question = screen.getByRole('group', { name: /^Delete Severity\?/ });
    await user.click(within(question).getByRole('button', { name: 'Delete field Severity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('3 tickets hold it');
    // Refused: the question stays open; Cancel gives the focus back to the first button (D13).
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete field Severity' })).toHaveFocus();
  });

  it('[CORE-009] asks before deleting an option whose child options or default go with it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Office' }));
    // A plain unused option comes back by typing its name: it goes at once (D13, T-267).
    const lisbon = await screen.findByRole('button', { name: 'Delete Lisbon' });
    expect(lisbon).toHaveClass('button-secondary');
    await user.click(lisbon);
    expect(await screen.findByText('Lisbon was deleted.')).toBeInTheDocument();
    // A child option the default names asks; a plain one does not.
    expect(screen.getByRole('button', { name: 'Delete Floor 1' })).toHaveClass(
      'button-danger-quiet',
    );
    expect(screen.getByRole('button', { name: 'Delete Floor 2' })).toHaveClass('button-secondary');
    // Madrid takes its two child options and the default.
    const madrid = screen.getByRole('button', { name: 'Delete Madrid' });
    expect(madrid).toHaveClass('button-danger-quiet');
    await user.click(madrid);
    const question = screen.getByRole('group', {
      name:
        'Delete Madrid and its 2 child options? They leave this list for good. New tickets in ' +
        'Everywhere start with Madrid: once it goes they start empty until a default is saved ' +
        'again. Options a ticket holds are not deleted: stop offering them instead. This cannot ' +
        'be undone.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Delete Madrid' })).toHaveFocus();
    expect(client.calls.filter((c) => c.action === 'deleteOption')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Delete Madrid' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Delete Madrid and/ })).getByRole('button', {
        name: 'Delete Madrid',
      }),
    );
    expect(await screen.findByText('Madrid was deleted.')).toBeInTheDocument();
    expect(client.calls.filter((c) => c.action === 'deleteOption')).toEqual([
      { action: 'deleteOption', args: [4, 40, 402] },
      { action: 'deleteOption', args: [4, 40, 401] },
    ]);
  });

  it('[CORE-009] asks before deleting a default option, and keeps the question when tickets hold it', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Severity' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Low' }));
    const low = screen.getByRole('group', {
      name:
        'Delete Low? It leaves this list for good. New tickets in Everywhere start with Low: once ' +
        'it goes they start empty until a default is saved again. An option a ticket holds is not ' +
        'deleted: stop offering it instead. This cannot be undone.',
    });
    await user.click(within(low).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Manage field Office' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Porto' }));
    const question = screen.getByRole('group', {
      name:
        'Delete Porto and its child option? They leave this list for good. Options a ticket ' +
        'holds are not deleted: stop offering them instead. This cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete Porto' }));
    // Refused: the reason shows, and the question stays open to cancel.
    expect(await screen.findByRole('alert')).toHaveTextContent('3 tickets hold it');
    expect(within(question).getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  it('[CORE-003] renames a field, describes it, and deletes one no ticket holds', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Customer' }));
    const details = await screen.findByRole('form', { name: 'Name and description of Customer' });
    const name = within(details).getByLabelText('Field name');
    await user.clear(name);
    await user.type(name, 'Client');
    const description = within(details).getByLabelText('Description');
    expect(description).toHaveValue('Who asked for it.');
    await user.clear(description);
    await user.type(description, 'The client who asked.');
    await user.click(
      within(details).getByRole('button', { name: 'Save the name and description' }),
    );
    expect(await screen.findByText('Client was saved.')).toBeInTheDocument();
    expect(client.calls[0]).toEqual({
      action: 'updateField',
      args: [1, { name: 'Client', description: 'The client who asked.' }],
    });
    expect(await screen.findByText('The client who asked.', { selector: 'p' })).toBeVisible();
    const trigger = screen.getByRole('button', { name: 'Delete field Client' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13); nothing is sent yet.
    const question = screen.getByRole('group', {
      name: 'Delete Client? Its field rules go with it and layouts stop showing it. This cannot be undone.',
    });
    expect(client.calls.map((c) => c.action)).toEqual(['updateField']);
    await user.click(within(question).getByRole('button', { name: 'Delete field Client' }));
    expect(await screen.findByText('Client was deleted.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual(['updateField', 'deleteField']);
    expect(screen.getByRole('heading', { level: 1, name: 'Fields' })).toHaveFocus();
  });

  it('[CORE-010] makes a paragraph with a length and a number shown as a currency', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New field' }));
    let form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'Notes');
    await user.type(within(form).getByLabelText('Description'), 'Anything else.');
    await user.selectOptions(within(form).getByLabelText('Type'), 'paragraph');
    await user.type(within(form).getByLabelText('Most characters'), '500');
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(await screen.findByText('Notes was added.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'createField',
      args: [
        {
          name: 'Notes',
          type: 'paragraph',
          description: 'Anything else.',
          config: { maxChars: 500 },
        },
      ],
    });

    await user.click(screen.getByRole('button', { name: 'New field' }));
    form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'Budget');
    await user.selectOptions(within(form).getByLabelText('Type'), 'number');
    await user.selectOptions(within(form).getByLabelText('Shows as'), 'currency');
    await user.selectOptions(within(form).getByLabelText('Decimals'), '2');
    await user.type(within(form).getByLabelText('Currency code'), 'eur');
    // A sample says how values will read on tickets and in lists.
    expect(
      within(form).getByText('1,234.5 shows as €1,234.50 on tickets and in lists.'),
    ).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(await screen.findByText('Budget was added.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[0]).toEqual({
      name: 'Budget',
      type: 'number',
      config: { format: 'currency', decimals: 2, currency: 'EUR' },
    });
  });

  it('[CORE-010] changes a number field’s settings, sending them whole', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Cost' }));
    const settings = await screen.findByRole('form', { name: 'Settings of Cost' });
    expect(within(settings).getByLabelText('Shows as')).toHaveValue('currency');
    await user.selectOptions(within(settings).getByLabelText('Shows as'), 'percentage');
    // The currency goes with the currency format only.
    expect(within(settings).queryByLabelText('Currency code')).toBeNull();
    await user.click(within(settings).getByRole('button', { name: 'Save the settings' }));
    expect(await screen.findByText('The settings of Cost were saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'updateField',
      args: [7, { config: { format: 'percentage', decimals: 2 } }],
    });
  });

  it('[CORE-011] checks a formula as it is typed and names where it is wrong', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New field' }));
    const form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'Spend');
    await user.selectOptions(within(form).getByLabelText('Type'), 'formula');
    const expression = within(form).getByLabelText('Expression');
    // Braces are typed doubled: a single one opens a key name for user-event.
    await user.type(expression, '{{Cost} * 2');
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DELAY_MS));
    expect(await within(form).findByText('It gives a number. It reads {Cost}.')).toBeVisible();
    await user.clear(expression);
    await user.type(expression, '{{Pionts} * 2');
    await act(() => vi.advanceTimersByTimeAsync(CHECK_DELAY_MS));
    expect(
      await within(form).findByText(
        'Line 1, column 1: No field is called {Pionts}, or a formula here cannot see it.',
      ),
    ).toBeVisible();
    expect(expression).toHaveAttribute('aria-invalid', 'true');
    // Saving it is refused with the same words, never the server's own.
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(
      await within(form).findByText(
        'Line 1, column 1: No field is called {Pionts}, or a formula here cannot see it.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/English words/)).toBeNull();
    // Decimals and a currency only for outputs that take them.
    await user.selectOptions(within(form).getByLabelText('Output'), 'date');
    expect(within(form).queryByLabelText('Decimals')).toBeNull();
    await user.selectOptions(within(form).getByLabelText('Output'), 'currency');
    await user.type(within(form).getByLabelText('Currency code'), 'USD');
    await user.clear(expression);
    await user.type(expression, '{{Cost} * 2');
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(await screen.findByText('Spend was added.')).toBeInTheDocument();
    expect(client.calls.filter((c) => c.action === 'createField').at(-1)?.args[0]).toEqual({
      name: 'Spend',
      type: 'formula',
      config: { expression: '{Cost} * 2', output: 'currency', currency: 'USD' },
    });
  });

  it('[CORE-011] lists what a formula can read and its functions', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Days left' }));
    const settings = await screen.findByRole('form', { name: 'Formula of Days left' });
    expect(within(settings).getByLabelText('Expression')).toHaveValue(
      'daysBetween(today(), {Due date})',
    );
    await user.click(within(settings).getByRole('button', { name: 'What a formula can use' }));
    const fields = within(settings).getByRole('list', { name: 'Fields it can read' });
    expect(within(fields).getByText('{Cost}')).toBeVisible();
    expect(within(fields).getByText('{Due date}')).toBeVisible();
    // A choice list is not read by formulas, and a formula does not read itself.
    expect(within(fields).queryByText('{Severity}')).toBeNull();
    expect(within(fields).queryByText('{Days left}')).toBeNull();
    const functions = within(settings).getByRole('list', { name: 'Functions' });
    expect(within(functions).getByText('workingDaysUntil')).toBeVisible();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Manage field Severity' })).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale, its panels too', async () => {
    const user = userEvent.setup();
    renderPage('en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    // Region: a two-level list with contexts, defaults and child options.
    const region = within(main).getByText('Region').closest('li') as HTMLElement;
    await user.click(within(region).getAllByRole('button')[0] as HTMLElement);
    await within(main).findAllByRole('form');
    const data = new Set([
      'Customer',
      'Severity',
      'Components',
      'Region',
      'Office',
      'Reviewer',
      'Cost',
      'Days left',
      'Who asked for it.',
      'Everywhere',
      'Europe',
      'Madrid',
      'Lisbon',
      'Americas',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('a local-mode track’s own fields, for whoever runs the track (T-322)', () => {
  function renderOwn(
    trackId: number | null,
    options: {
      session?: Session;
      locale?: Locale;
      client?: ReturnType<typeof fakeFieldsClient>;
    } = {},
  ) {
    const client = options.client ?? fakeFieldsClient();
    render(
      <I18nProvider locale={options.locale ?? 'en'}>
        <SessionProvider session={options.session ?? TRACK_ADMIN}>
          <main>
            <FieldsAdminPage client={client} trackId={trackId} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    return client;
  }

  it('[CORE-003] [IAM-030] lists only the fields the track owns, and adds one that covers it alone', async () => {
    const user = userEvent.setup();
    const client = renderOwn(4);
    expect(await screen.findByText('OPS · Operations')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Manage field Components' })).toBeVisible();
    // Shared fields reach OPS, but they are the administrators'.
    expect(screen.queryByRole('button', { name: 'Manage field Severity' })).toBeNull();
    expect(screen.queryByText('One track')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to managing OPS.' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );

    await user.click(screen.getByRole('button', { name: 'New field' }));
    const form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'Shift');
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(await screen.findByText('Shift was added.')).toBeInTheDocument();
    expect(client.calls[0]).toEqual({
      action: 'createField',
      args: [{ name: 'Shift', type: 'text', trackId: 4 }],
    });
    // Its context covers OPS only, and the form says so instead of listing tracks.
    await user.click(await screen.findByRole('button', { name: 'Change context Default' }));
    const change = screen.getByRole('form', { name: 'Change context Default' });
    expect(
      within(change).getByText('It covers Operations only: the field belongs to that track.'),
    ).toBeVisible();
    expect(within(change).queryByRole('group', { name: 'Tracks' })).toBeNull();
  });

  it('[CORE-009] a person field of the track offers its roles and its people, never the site’s lists', async () => {
    const user = userEvent.setup();
    const client = renderOwn(4);
    await user.click(await screen.findByRole('button', { name: 'New field' }));
    const form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'On call');
    await user.selectOptions(within(form).getByLabelText('Type'), 'user');
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    await user.click(await screen.findByRole('button', { name: 'Change context Default' }));
    const change = screen.getByRole('form', { name: 'Change context Default' });
    const offer = within(change).getByLabelText('Offer');
    // No list of groups for those who run a track: only anyone, or a track role's holders.
    expect(within(offer).queryByRole('option', { name: 'The members of a group' })).toBeNull();
    await user.selectOptions(offer, 'role');
    await user.selectOptions(within(change).getByLabelText('Track role'), 'Members');
    await user.click(within(change).getByRole('button', { name: 'Save the context' }));
    expect(await screen.findByText('The context Default was saved.')).toBeInTheDocument();
    expect(
      screen.getByText('People to choose from: whoever holds Members in the ticket’s track'),
    ).toBeVisible();
    // The default person is found among the people of the track.
    const fallback = screen.getByRole('form', { name: 'Default value in Default' });
    await user.type(within(fallback).getByLabelText('Default value'), 'Ana');
    await user.click(await within(fallback).findByRole('button', { name: 'Ana Ruiz' }));
    await user.click(within(fallback).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Default was saved.')).toBeInTheDocument();
    expect(client.reads).toContain('trackRoles 4');
    expect(client.reads).toContain('findTrackPeople OPS');
    expect(
      client.reads.filter((r) => ['groups', 'roles', 'findPeople', 'tracks'].includes(r)),
    ).toEqual([]);
  });

  it('[CORE-009] a person field limited to a group before keeps it, by its words', async () => {
    const user = userEvent.setup();
    const client = fakeFieldsClient();
    const made = await client.createField({ name: 'Approver', type: 'user', trackId: 4 });
    const context = made.contexts[0]?.id as number;
    await client.updateContext(made.id, context, { config: { userGroupId: 21 } });
    client.calls.length = 0;
    renderOwn(4, { client });
    await user.click(await screen.findByRole('button', { name: 'Manage field Approver' }));
    expect(
      await screen.findByText('People to choose from: the members of the group chosen before'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change context Default' }));
    const change = screen.getByRole('form', { name: 'Change context Default' });
    expect(within(change).getByLabelText('Offer')).toHaveDisplayValue('The members of a group');
    expect(within(change).getByLabelText('Group')).toHaveDisplayValue('The group chosen before');
    await user.click(within(change).getByRole('button', { name: 'Save the context' }));
    expect(await screen.findByText('The context Default was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[2]).toMatchObject({
      config: { userGroupId: 21, userRoleId: null },
    });
  });

  it('[CORE-009] a group field’s default finds groups in the site’s list, which a configuration administrator may always read', async () => {
    const user = userEvent.setup();
    const client = fakeFieldsClient();
    await client.createField({ name: 'Approvers', type: 'group' });
    client.calls.length = 0;
    renderOwn(null, { client, session: CONFIG_ADMIN });
    await user.click(await screen.findByRole('button', { name: 'Manage field Approvers' }));
    const fallback = screen.getByRole('form', { name: 'Default value in Default' });
    await user.type(within(fallback).getByLabelText('Default value'), 'Rev');
    await user.click(await within(fallback).findByRole('button', { name: 'Reviewers' }));
    await user.click(within(fallback).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Default was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: 21 });
    // Not through the field, which needs Browse users and groups as well.
    expect(client.reads).toContain('findGroups');
    expect(client.reads.filter((r) => r.startsWith('findFieldGroups'))).toEqual([]);
  });

  it('[CORE-009] [IAM-030] a group field’s default on the track’s page finds groups through the field', async () => {
    const user = userEvent.setup();
    const client = fakeFieldsClient();
    const made = await client.createField({ name: 'Approvers', type: 'group', trackId: 4 });
    client.calls.length = 0;
    renderOwn(4, { client });
    await user.click(await screen.findByRole('button', { name: 'Manage field Approvers' }));
    const fallback = screen.getByRole('form', { name: 'Default value in Default' });
    await user.type(within(fallback).getByLabelText('Default value'), 'Sup');
    await user.click(await within(fallback).findByRole('button', { name: 'Support' }));
    await user.click(within(fallback).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Default was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: 22 });
    // The site's list of groups is for administrators.
    expect(client.reads).toContain(`findFieldGroups ${made.id}`);
    expect(client.reads.filter((r) => r === 'findGroups' || r === 'groups')).toEqual([]);
  });

  it('[CORE-009] an administrator on the track’s page keeps the site’s lists', async () => {
    const user = userEvent.setup();
    const client = renderOwn(4, { session: ADMIN });
    await user.click(await screen.findByRole('button', { name: 'Manage field Components' }));
    await screen.findByRole('button', { name: 'Change context OPS' });
    expect(client.reads).not.toContain('tracks');
    await user.click(screen.getByRole('button', { name: 'New field' }));
    const form = screen.getByRole('form', { name: 'Add a field' });
    await user.type(within(form).getByLabelText('Field name'), 'Owner');
    await user.selectOptions(within(form).getByLabelText('Type'), 'user');
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    await user.click(await screen.findByRole('button', { name: 'Change context Default' }));
    const offer = within(
      screen.getByRole('form', { name: 'Change context Default' }),
    ).getByLabelText('Offer');
    expect(
      within(offer).getByRole('option', { name: 'The members of a group' }),
    ).toBeInTheDocument();
    expect(client.reads).toContain('groups');
    expect(client.reads).toContain('roles');
  });

  it('[IAM-030] on the shared page offers someone who runs tracks only those with their own configuration', async () => {
    renderOwn(null);
    expect(await screen.findByRole('link', { name: 'Fields of OPS · Operations' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4/fields',
    );
    expect(screen.queryByRole('link', { name: /PAY/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New field' })).toBeNull();
  });

  it('[IAM-030] says a track in shared mode owns no fields, and refuses a track they do not run', async () => {
    renderOwn(1);
    expect(
      await screen.findByText(
        'PAY uses shared configuration, so its fields are shared, and site and configuration administrators change them.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New field' })).toBeNull();
  });

  it('says when the track owns no field yet', async () => {
    const client = fakeFieldsClient();
    await client.deleteField(3);
    renderOwn(4, { client });
    expect(await screen.findByText('OPS has no field of its own yet.')).toBeVisible();
  });

  it('fits a small phone, in Spanish too', async () => {
    setViewportWidth(375);
    renderOwn(4, { locale: 'es' });
    expect(
      await screen.findByRole('button', { name: 'Gestionar el campo Components' }),
    ).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderOwn(4, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const components = within(main).getByText('Components').closest('li') as HTMLElement;
    await user.click(within(components).getAllByRole('button')[0] as HTMLElement);
    await within(main).findAllByRole('form');
    const data = new Set(['Components', 'OPS']);
    expect(untranslated(visibleTexts(main)).filter((t) => !data.has(t))).toEqual([]);
  });
});

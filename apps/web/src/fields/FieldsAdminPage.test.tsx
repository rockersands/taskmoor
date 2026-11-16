import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
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
    await user.click(screen.getByRole('button', { name: 'Delete North east' }));
    expect(await screen.findByText('North east was deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename North east' })).toBeNull();
  });

  it('[CORE-009] says how many tickets hold an option it may not delete', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Severity' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Medium' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '3 tickets hold it, the trash included. Stop offering it instead.',
    );
    await user.click(screen.getByRole('button', { name: 'Delete field Severity' }));
    const question = screen.getByRole('group', { name: /^Delete Severity\?/ });
    await user.click(within(question).getByRole('button', { name: 'Delete field Severity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('3 tickets hold it');
    // Refused: the question stays open; Cancel gives the focus back to the first button (D13).
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete field Severity' })).toHaveFocus();
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

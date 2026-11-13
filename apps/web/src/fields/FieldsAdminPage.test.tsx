import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { FieldsAdminPage } from './FieldsAdminPage';
import { fakeFieldsClient } from './fixtures';

function renderPage(locale: Locale = 'en') {
  const client = fakeFieldsClient();
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

describe('field administration (M1-053)', () => {
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
    await user.type(within(form).getByLabelText('Field name'), 'Region');
    await user.selectOptions(within(form).getByLabelText('Type'), 'select');
    await user.click(within(form).getByLabelText('Holds several values'));
    await user.click(within(form).getByRole('button', { name: 'Add a field' }));
    expect(await screen.findByText('Region was added.')).toBeInTheDocument();
    expect(client.calls[0]).toEqual({
      action: 'createField',
      args: [{ name: 'Region', type: 'select', multiple: true }],
    });

    const add = await screen.findByRole('form', { name: 'Add an option to Everywhere' });
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
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('3 tickets hold it');
  });

  it('[CORE-003] renames a field and deletes one no ticket holds', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage field Customer' }));
    const rename = await screen.findByRole('form', { name: 'Rename Customer' });
    const name = within(rename).getByLabelText('Field name');
    await user.clear(name);
    await user.type(name, 'Client');
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Client was renamed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete field Client' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Client was deleted.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual(['updateField', 'deleteField']);
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Manage field Severity' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set(['Customer', 'Severity', 'Components']);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

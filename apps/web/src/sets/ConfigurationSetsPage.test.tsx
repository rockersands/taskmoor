import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { ConfigurationSetsPage } from './ConfigurationSetsPage';
import { fakeSetsClient } from './fixtures';

function renderPage(locale: Locale = 'en') {
  const client = fakeSetsClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADMIN}>
        <main>
          <ConfigurationSetsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('configuration set administration (M1-053)', () => {
  it('[CORE-008] adds a type set, drops a type from it and deletes it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await screen.findByRole('form', { name: 'Add a type set' });
    await user.type(within(form).getByLabelText('Type set name'), 'Support types');
    await user.click(within(form).getByLabelText('Bug'));
    await user.click(within(form).getByLabelText('Task'));
    await user.click(within(form).getByRole('button', { name: 'Add a type set' }));
    expect(await screen.findByText('Support types was added.')).toBeInTheDocument();
    const panel = await screen.findByRole('form', { name: 'Settings of Support types' });
    await user.click(within(panel).getByLabelText('Bug'));
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Support types was saved.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Delete set Support types' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Support types was deleted.')).toBeInTheDocument();
    expect(client.calls.map((c) => [c.action, c.args.at(-1)])).toEqual([
      ['createTypeSet', { name: 'Support types', ticketTypeIds: [5, 6] }],
      ['updateTypeSet', { ticketTypeIds: [6] }],
      ['deleteTypeSet', 101],
    ]);
  });

  it('[CORE-003] makes fields required or hidden with help text, keeping rules for one type', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Default field rules' }));
    const summary = await screen.findByRole('group', { name: 'Summary' });
    expect(within(summary).getByLabelText('Required')).toBeChecked();
    expect(within(summary).getByLabelText('Required')).toBeDisabled();
    expect(
      within(screen.getByRole('group', { name: 'Description' })).getByLabelText('Help text'),
    ).toHaveValue('What happened, and what you expected');

    const priority = screen.getByRole('group', { name: 'Priority' });
    await user.click(within(priority).getByLabelText('Required'));
    // Required and hidden never go together.
    expect(within(priority).getByLabelText('Hidden')).toBeDisabled();
    const customer = screen.getByRole('group', { name: 'Customer' });
    await user.click(within(customer).getByLabelText('Hidden'));
    await user.type(
      within(screen.getByRole('group', { name: 'Due date' })).getByLabelText('Help text'),
      'When it must be done',
    );
    await user.click(screen.getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Default field rules was saved.')).toBeInTheDocument();
    const last = client.calls.at(-1) as { args: unknown[] };
    const rules = (last.args[1] as { rules: unknown[] }).rules;
    expect(rules).toEqual([
      expect.objectContaining({ ticketTypeId: 5, field: 'environment', required: true }),
      expect.objectContaining({ ticketTypeId: null, field: 'description' }),
      expect.objectContaining({ field: 'priority', required: true, hidden: false }),
      expect.objectContaining({ field: 'dueDate', description: 'When it must be done' }),
      expect.objectContaining({ field: 'cf[40]', hidden: true }),
    ]);
    // The default set is never deleted.
    expect(screen.queryByRole('button', { name: /^Delete set/ })).toBeNull();
  });

  it('refuses to delete a type set tracks use', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Software types' }));
    expect(await screen.findByText('Used by SHOP.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete set Software types' })).toBeNull();
  });

  it('[CORE-008] says how field rules and layouts combine, and links to the layout sets (UI-T15)', async () => {
    renderPage();
    const rules = await screen.findByRole('heading', { name: 'Field rule sets' });
    const note = rules.nextElementSibling as HTMLElement;
    expect(note).toHaveTextContent(
      'a hidden field never appears, even where a layout places it, and a required field always does.',
    );
    expect(
      within(note).getByRole('link', { name: 'Arrange the forms on Layout sets.' }),
    ).toHaveAttribute('href', '#/admin/layouts');
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Manage Software types' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage('en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set(['Software types', 'Default field rules', 'Bug', 'Task', 'Story']);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { ConfigurationSetsPage } from './ConfigurationSetsPage';
import { type FakeSetsClient, fakeSetsClient } from './fixtures';

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
    // The sets come first; "New type set" opens the form (D11, AD-18).
    const typeSets = await screen.findByRole('region', { name: 'Type sets' });
    expect(screen.queryByRole('form', { name: 'Add a type set' })).toBeNull();
    const opener = await within(typeSets).findByRole('button', { name: 'New type set' });
    await user.click(opener);
    const form = screen.getByRole('form', { name: 'Add a type set' });
    await user.type(within(form).getByLabelText('Type set name'), 'Support types');
    await user.click(within(form).getByLabelText('Bug'));
    await user.click(within(form).getByLabelText('Task'));
    await user.click(within(form).getByRole('button', { name: 'Add a type set' }));
    expect(await screen.findByText('Support types was added.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a type set' })).toBeNull();
    expect(opener).toHaveFocus();
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

  it('[CORE-008] says what kind of track a default type set is for (AD-25)', async () => {
    renderPage();
    expect(await screen.findByText('Default for software tracks')).toBeVisible();
  });

  it('[CORE-008] says how field rules and layouts combine, and links to the layout sets (UI-T15)', async () => {
    renderPage();
    const rules = await screen.findByRole('heading', { name: 'Field rule sets' });
    // The heading shares its row with the New button; the note follows the row.
    const note = rules.parentElement?.nextElementSibling as HTMLElement;
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

describe('a local-mode track’s own configuration sets, for whoever runs the track (T-163a)', () => {
  function renderOwn(
    trackId: number | null,
    options: { session?: Session; locale?: Locale; client?: FakeSetsClient } = {},
  ) {
    const client = options.client ?? fakeSetsClient();
    render(
      <I18nProvider locale={options.locale ?? 'en'}>
        <SessionProvider session={options.session ?? TRACK_ADMIN}>
          <main>
            <ConfigurationSetsPage client={client} trackId={trackId} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    return client;
  }
  const manageButtons = () =>
    screen.getAllByRole('button', { name: /^Manage / }).map((b) => b.getAttribute('aria-label'));

  it('[CORE-005] shows the type set the track owns and changes its types, adding and deleting none', async () => {
    const user = userEvent.setup();
    const client = renderOwn(4);
    expect(await screen.findByText('OPS · Operations')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Manage Operations types' }));
    // Neither the shared type sets nor another track's.
    expect(manageButtons()).toEqual(['Manage Operations types', 'Manage Ops rules']);
    expect(screen.queryByRole('form', { name: 'Add a type set' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New type set' })).toBeNull();
    expect(
      screen.getByText(
        'A track with its own configuration keeps one type set of its own: choose its ticket types here.',
      ),
    ).toBeVisible();
    const panel = screen.getByRole('form', { name: 'Settings of Operations types' });
    // The types that reach OPS: the shared ones and its own Runbook.
    expect(within(panel).getByLabelText('Runbook')).toBeChecked();
    await user.click(within(panel).getByLabelText('Task'));
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Operations types was saved.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /^Delete set/ })).toBeNull();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      ['updateTypeSet', 30, { ticketTypeIds: [5, 9, 6] }],
    ]);
  });

  it('[CORE-003] adds rule sets for the track, with its own fields, and makes the track use one', async () => {
    const user = userEvent.setup();
    const client = renderOwn(4);
    await user.click(await screen.findByRole('button', { name: 'Manage Ops rules' }));
    expect(await screen.findByRole('group', { name: 'Ops notes' })).toBeVisible();
    expect(screen.queryByText('Default field rules')).toBeNull();
    expect(screen.queryByText('Lab rules')).toBeNull();
    const use = screen.getByRole('button', { name: 'Use this set for OPS' });
    await user.click(use);
    expect(await screen.findByText('OPS now uses Ops rules.')).toBeInTheDocument();
    expect(await screen.findByText('Used by OPS.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this set for OPS' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'New field rule set' }));
    const add = screen.getByRole('form', { name: 'Add a field rule set' });
    await user.type(within(add).getByLabelText('Rule set name'), 'Ops intake rules');
    await user.click(within(add).getByRole('button', { name: 'Add a field rule set' }));
    expect(await screen.findByText('Ops intake rules was added.')).toBeInTheDocument();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      ['assignRuleSet', 4, 11],
      ['createRuleSet', { name: 'Ops intake rules', trackId: 4 }],
    ]);
  });

  it('[IAM-030] on the shared page offers a track administrator only the tracks they run with their own configuration', async () => {
    renderOwn(null);
    const link = await screen.findByRole('link', {
      name: 'Configuration sets of OPS · Operations',
    });
    expect(link).toHaveAttribute('href', '#/manage/tracks/4/configuration-sets');
    expect(screen.queryByRole('link', { name: /SHOP|LAB/ })).toBeNull();
    expect(screen.queryByText('Software types')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a type set' })).toBeNull();
  });

  it('[IAM-030] refuses a track they do not run, and someone who runs none', async () => {
    renderOwn(6);
    expect(
      await screen.findByText(
        'Only the people who run this track, and site and configuration administrators, change its configuration.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Lab rules')).toBeNull();
    cleanup();
    renderOwn(null, { session: MEMBER });
    expect(
      screen.getByText(
        'Only site and configuration administrators, and the people who run a track with its own configuration, manage configuration sets.',
      ),
    ).toBeVisible();
  });

  it('[CORE-013] keeps the rule of a field that does not reach the track when it saves the set', async () => {
    const user = userEvent.setup();
    const client = fakeSetsClient();
    const elsewhere = {
      ticketTypeId: null,
      field: 'cf[99]',
      required: true,
      hidden: false,
      description: null,
      editableBy: null,
    };
    const read = client.ruleSet;
    client.ruleSet = async (id) => ({ ...(await read(id)), rules: [elsewhere] });
    renderOwn(4, { client });
    await user.click(await screen.findByRole('button', { name: 'Manage Ops rules' }));
    const panel = await screen.findByRole('form', { name: 'Settings of Ops rules' });
    expect(within(panel).queryByRole('group', { name: 'cf[99]' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Ops rules was saved.')).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'updateRuleSet')?.args[1]).toEqual({
      rules: [elsewhere],
    });
  });

  it('links to the track’s own layout sets and back to its Manage page', async () => {
    renderOwn(4);
    expect(
      await screen.findByRole('link', { name: 'Arrange the forms of OPS on its layout sets.' }),
    ).toHaveAttribute('href', '#/manage/tracks/4/layouts');
    expect(screen.getByRole('link', { name: 'Back to managing OPS.' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );
  });

  it('fits a small phone, in Spanish too', async () => {
    setViewportWidth(375);
    renderOwn(4, { locale: 'es' });
    expect(await screen.findByRole('button', { name: 'Gestionar Operations types' })).toBeVisible();
    expect(
      screen.getByRole('link', {
        name: 'Organiza los formularios de OPS en sus conjuntos de diseños.',
      }),
    ).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderOwn(4, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set(['Operations types', 'Ops rules']);
    expect(untranslated(visibleTexts(main)).filter((t) => !data.has(t))).toEqual([]);
  });
});

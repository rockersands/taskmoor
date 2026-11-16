import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
    const trigger = within(panel).getByRole('button', { name: 'Delete set Support types' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13).
    const question = within(panel).getByRole('group', {
      name: 'Delete Support types? Nothing can use it afterwards, and this cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete set Support types' }));
    expect(await screen.findByText('Support types was deleted.')).toBeInTheDocument();
    expect(within(typeSets).getByRole('heading', { name: 'Type sets' })).toHaveFocus();
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

  it('[CORE-005] orders a set’s types, preselects one and makes the set the default for a kind of track', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Software types' }));
    const panel = screen.getByRole('form', { name: 'Settings of Software types' });
    const order = within(panel).getByRole('list', { name: 'Order in the set' });
    expect(order).toHaveAccessibleDescription('The create form offers the types in this order.');
    const names = () =>
      within(order)
        .getAllByRole('listitem')
        .map((item) => item.firstChild?.textContent);
    expect(names()).toEqual(['Bug', 'Task', 'Story']);
    expect(within(panel).getByRole('button', { name: 'Move Bug up' })).toBeDisabled();
    await user.click(within(panel).getByRole('button', { name: 'Move Story up' }));
    expect(names()).toEqual(['Bug', 'Story', 'Task']);
    // The keyboard stays on the type it moved.
    expect(within(panel).getByRole('button', { name: 'Move Story up' })).toHaveFocus();
    await user.click(within(panel).getByRole('button', { name: 'Move Story up' }));
    expect(names()).toEqual(['Story', 'Bug', 'Task']);
    // At the top, Up is not offered: the keyboard goes to Down.
    expect(within(panel).getByRole('button', { name: 'Move Story down' })).toHaveFocus();

    const preselected = within(panel).getByLabelText('Preselected type');
    expect(preselected).toHaveDisplayValue('Task');
    await user.selectOptions(preselected, 'Story');
    // The set is the default for software tracks, which another set must take over to change.
    const kinds = within(panel).getByRole('group', {
      name: 'Default set for new tracks of these kinds',
    });
    expect(within(kinds).getByLabelText('Software tracks')).toBeChecked();
    expect(within(kinds).getByLabelText('Software tracks')).toBeDisabled();
    expect(kinds).toHaveAccessibleDescription(
      'Every kind of track has a default set. To give one up, tick it on another set instead.',
    );
    await user.click(within(kinds).getByLabelText('Business tracks'));
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Software types was saved.')).toBeInTheDocument();
    expect(await screen.findByText('Default for software and business tracks')).toBeVisible();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      [
        'updateTypeSet',
        1,
        { ticketTypeIds: [7, 5, 6], defaultTypeId: 7, defaultFor: ['software', 'business'] },
      ],
    ]);
  });

  it('[CORE-005] adds a set with its preselected type and the kind of track it is the default for', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New type set' }));
    const form = screen.getByRole('form', { name: 'Add a type set' });
    await user.type(within(form).getByLabelText('Type set name'), 'Support types');
    await user.click(within(form).getByLabelText('Task'));
    await user.click(within(form).getByLabelText('Bug'));
    await user.selectOptions(within(form).getByLabelText('Preselected type'), 'Bug');
    // Unticking the preselected type leaves none preselected: the first in the order then.
    await user.click(within(form).getByLabelText('Bug'));
    expect(within(form).getByLabelText('Preselected type')).toHaveDisplayValue(
      'None: the first type in the order',
    );
    await user.click(within(form).getByLabelText('Bug'));
    await user.selectOptions(within(form).getByLabelText('Preselected type'), 'Bug');
    await user.click(within(form).getByLabelText('Service tracks'));
    await user.click(within(form).getByRole('button', { name: 'Add a type set' }));
    expect(await screen.findByText('Support types was added.')).toBeInTheDocument();
    expect(await screen.findByText('Default for service tracks')).toBeVisible();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      [
        'createTypeSet',
        { name: 'Support types', ticketTypeIds: [6, 5], defaultTypeId: 5, defaultFor: ['service'] },
      ],
    ]);
  });

  it('[CORE-005] (2) asks where the tickets of a dropped type go, and maps them to a type of their level', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Software types' }));
    const panel = screen.getByRole('form', { name: 'Settings of Software types' });
    await user.click(within(panel).getByLabelText('Bug'));
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Tickets have a type the set would drop: choose the type they take below, then save again.',
    );
    const mapping = within(panel).getByRole('group', { name: 'Tickets of the types you drop' });
    expect(mapping).toHaveAccessibleDescription(
      '7 tickets in the tracks that use this set have a type the set would drop. Choose the type they take, at the same level, then save again.',
    );
    const target = within(mapping).getByLabelText('Tickets of Bug become');
    // The question takes the keyboard; the choices are the kept types of Bug's level.
    expect(target).toHaveFocus();
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a type', 'Task', 'Story']);
    await user.selectOptions(target, 'Task');
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(
      await screen.findByText('Software types was saved; 7 tickets took another type.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      within(panel).queryByRole('group', { name: 'Tickets of the types you drop' }),
    ).toBeNull();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      ['updateTypeSet', 1, { ticketTypeIds: [6, 7] }],
      ['updateTypeSet', 1, { ticketTypeIds: [6, 7], ticketTypeMapping: { '5': 6 } }],
    ]);
  });

  it('[CORE-005] (2) keeps a dropped type mapped before while another is mapped, and counts them all', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Software types' }));
    const panel = screen.getByRole('form', { name: 'Settings of Software types' });
    const save = () => user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    const mapping = () =>
      within(panel).getByRole('group', { name: 'Tickets of the types you drop' });
    await user.click(within(panel).getByLabelText('Bug'));
    await user.click(within(panel).getByLabelText('Task'));
    await save();
    await screen.findByRole('alert');
    expect(mapping()).toHaveAccessibleDescription(/^9 tickets in the tracks/);
    // Only Bug's tickets are given a type: the server names Task alone the second time.
    await user.selectOptions(within(mapping()).getByLabelText('Tickets of Bug become'), 'Story');
    await save();
    await waitFor(() => expect(client.calls).toHaveLength(2));
    expect(within(mapping()).getByLabelText('Tickets of Bug become')).toHaveDisplayValue('Story');
    expect(mapping()).toHaveAccessibleDescription(/^9 tickets in the tracks/);
    await user.selectOptions(within(mapping()).getByLabelText('Tickets of Task become'), 'Story');
    await save();
    expect(
      await screen.findByText('Software types was saved; 9 tickets took another type.'),
    ).toBeInTheDocument();
    expect(client.calls.map((c) => c.args[1])).toEqual([
      // Task was the set's default type: with it dropped, the set has none.
      { ticketTypeIds: [7], defaultTypeId: null },
      { ticketTypeIds: [7], defaultTypeId: null, ticketTypeMapping: { '5': 7 } },
      { ticketTypeIds: [7], defaultTypeId: null, ticketTypeMapping: { '5': 7, '6': 7 } },
    ]);
  });

  it('[CORE-005] (2) a type dropped after the question appears joins it, keeping the earlier choice', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Software types' }));
    const panel = screen.getByRole('form', { name: 'Settings of Software types' });
    const save = () => user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    const mapping = () =>
      within(panel).getByRole('group', { name: 'Tickets of the types you drop' });
    await user.click(within(panel).getByLabelText('Bug'));
    await save();
    await user.selectOptions(await within(panel).findByLabelText('Tickets of Bug become'), 'Story');
    await user.click(within(panel).getByLabelText('Task'));
    await save();
    await waitFor(() => expect(client.calls).toHaveLength(2));
    expect(within(mapping()).getByLabelText('Tickets of Bug become')).toHaveDisplayValue('Story');
    expect(mapping()).toHaveAccessibleDescription(/^9 tickets in the tracks/);
    await user.selectOptions(within(mapping()).getByLabelText('Tickets of Task become'), 'Story');
    await save();
    expect(
      await screen.findByText('Software types was saved; 9 tickets took another type.'),
    ).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[1]).toEqual({
      ticketTypeIds: [7],
      defaultTypeId: null,
      ticketTypeMapping: { '5': 7, '6': 7 },
    });
  });

  it('[CORE-005] (2) says when the set keeps no type at a dropped type’s level, and forgets a type ticked again', async () => {
    const user = userEvent.setup();
    const client = fakeSetsClient();
    const read = client.ticketTypes;
    // Task and Story sit at Outcome here: nothing the set keeps shares Bug's level.
    client.ticketTypes = async (trackId) =>
      (await read(trackId)).map((type) =>
        type.id === 5 ? type : { ...type, level: { id: 3, name: 'Outcome' } },
      );
    render(
      <I18nProvider locale="en">
        <SessionProvider session={ADMIN}>
          <main>
            <ConfigurationSetsPage client={client} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Manage Software types' }));
    const panel = screen.getByRole('form', { name: 'Settings of Software types' });
    await user.click(within(panel).getByLabelText('Bug'));
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(
      await within(panel).findByText(
        'The set keeps no type at the Standard level, so tickets of Bug have nowhere to go: keep Bug, or add a type of that level.',
      ),
    ).toBeVisible();
    // Bug kept after all: no question, and nothing about where its tickets go.
    await user.click(within(panel).getByLabelText('Bug'));
    expect(
      within(panel).queryByRole('group', { name: 'Tickets of the types you drop' }),
    ).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Software types was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args).toEqual([1, { ticketTypeIds: [6, 7, 5] }]);
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
    // Its order and preselected type are its own; a track's own set is never a default.
    expect(within(panel).getByRole('list', { name: 'Order in the set' })).toBeVisible();
    expect(within(panel).getByLabelText('Preselected type')).toHaveDisplayValue('Bug');
    expect(
      within(panel).queryByRole('group', { name: 'Default set for new tracks of these kinds' }),
    ).toBeNull();
    expect(client.calls.map((c) => [c.action, ...c.args])).toEqual([
      ['updateTypeSet', 30, { ticketTypeIds: [5, 9, 6] }],
    ]);
  });

  it('[NFR-005] keyboard focus goes to the note that the track uses the set, not to the page (T-225)', async () => {
    const user = userEvent.setup();
    renderOwn(4);
    await user.click(await screen.findByRole('button', { name: 'Manage Ops rules' }));
    const use = await screen.findByRole('button', { name: 'Use this set for OPS' });
    use.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('OPS now uses Ops rules.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this set for OPS' })).toBeNull();
    expect(await screen.findByText('Used by OPS.')).toHaveFocus();
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

  it('[IAM-030] tells someone whose only track is archived that it is archived, not that they may not be here (T-224)', async () => {
    // The tracks someone runs leave out archived ones, so the session says they run none.
    const client = fakeSetsClient({ runs: [] });
    const read = client.track;
    client.track = async (id) => ({ ...(await read(id)), archived: id === 4 });
    const session: Session = {
      status: 'signed-in',
      user: {
        id: 4,
        name: 'Tam',
        email: 'tam@example.com',
        isSiteAdmin: false,
        isConfigAdmin: false,
        managesTracks: false,
        timeZone: null,
        locale: null,
      },
    };
    renderOwn(4, { client, session });
    expect(
      await screen.findByText('OPS is archived: its configuration changes once it is restored.'),
    ).toBeVisible();
    expect(screen.queryByText(/^Only site and configuration administrators/)).toBeNull();
    expect(screen.queryByText('Ops rules')).toBeNull();
    // A track that is not archived still refuses them as before.
    cleanup();
    renderOwn(6, { client, session });
    expect(
      await screen.findByText(
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

  it('[CORE-013] keeps the rule of a field that reached the track while the panel was open (T-223)', async () => {
    const user = userEvent.setup();
    const client = fakeSetsClient();
    const arrived = {
      ticketTypeId: null,
      field: 'cf[99]',
      required: true,
      hidden: false,
      description: null,
      editableBy: null,
    };
    const read = client.ruleSet;
    client.ruleSet = async (id) => ({ ...(await read(id)), rules: [arrived] });
    const fields = client.customFields;
    let reached = false;
    client.customFields = async (trackId) => [
      ...(await fields(trackId)),
      ...(reached ? [{ id: 99, name: 'Region' }] : []),
    ];
    renderOwn(4, { client });
    await user.click(await screen.findByRole('button', { name: 'Manage Ops rules' }));
    const panel = await screen.findByRole('form', { name: 'Settings of Ops rules' });
    // Someone gives the field to the track; the page reads the fields again after the assignment.
    reached = true;
    await user.click(within(panel).getByRole('button', { name: 'Use this set for OPS' }));
    expect(await screen.findByText('OPS now uses Ops rules.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Save the set' }));
    expect(await screen.findByText('Ops rules was saved.')).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'updateRuleSet')?.args[1]).toEqual({
      rules: [arrived],
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

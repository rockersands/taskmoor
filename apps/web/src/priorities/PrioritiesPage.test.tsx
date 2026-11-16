import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type FakePrioritiesClient, fakePrioritiesClient } from './fixtures';
import { PrioritiesPage } from './PrioritiesPage';

function renderPage(
  session: Session = ADMIN,
  {
    locale = 'en',
    client = fakePrioritiesClient(),
  }: { locale?: Locale; client?: FakePrioritiesClient } = {},
) {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <PrioritiesPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

const card = (name: string) => screen.getByRole('region', { name });
const priorities = () => card('Priorities, most urgent first');
const sets = () => card('Priority sets');
const reasons = () => card('Close reasons');
/** The names of a card's rows, in order. */
const rowNames = (region: HTMLElement) =>
  within(within(region).getByRole('list'))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.people-name')?.textContent);

describe('priorities, priority sets and close reasons (T-320)', () => {
  it('[CORE-014] lists the priorities in order, each with the icon of its place', async () => {
    renderPage();
    await screen.findByText('Urgent');
    expect(rowNames(priorities())).toEqual(['Urgent', 'High', 'Normal', 'Low', 'Very low']);
    expect(within(priorities()).getByText('Drop everything.')).toBeVisible();
    // No icon or colour controls: neither changes what anything draws.
    expect(within(priorities()).queryByLabelText(/icon|colour/i)).toBeNull();
    expect(
      within(priorities()).getByText(/^A new priority joins the default priority set\./),
    ).toBeVisible();
    expect(
      within(priorities()).getByRole('button', { name: 'Move priority Urgent up' }),
    ).toBeDisabled();
    expect(
      within(priorities()).getByRole('button', { name: 'Move priority Very low down' }),
    ).toBeDisabled();
  });

  it('[CORE-014] adds a priority, which joins the default set, then renames and moves it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await screen.findByText('Urgent');
    const opener = within(priorities()).getByRole('button', { name: 'New priority' });
    await user.click(opener);
    const form = within(priorities()).getByRole('form', { name: 'Add a priority' });
    await user.type(within(form).getByLabelText('Name'), 'Someday');
    await user.type(within(form).getByLabelText('Description (optional)'), 'When there is time.');
    await user.click(within(form).getByRole('button', { name: 'Add a priority' }));
    expect(await within(priorities()).findByText('Someday was added.')).toBeInTheDocument();
    // The form closes and the focus goes back to New priority (D11).
    expect(opener).toHaveFocus();
    expect(rowNames(priorities()).at(-1)).toBe('Someday');
    expect(
      within(sets()).getByText(/^Offers Urgent, High, Normal, Low, Very low, and Someday\./),
    ).toBeVisible();

    await user.click(within(priorities()).getByRole('button', { name: 'Change priority Someday' }));
    const change = within(priorities()).getByRole('form', { name: 'Change priority Someday' });
    const name = within(change).getByLabelText('Name');
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, 'Later');
    await user.click(within(change).getByRole('button', { name: 'Save' }));
    expect(await within(priorities()).findByText('Later was saved.')).toBeInTheDocument();
    expect(
      within(priorities()).getByRole('button', { name: 'Change priority Later' }),
    ).toHaveFocus();

    // At the bottom Down is off; moved up, the focus stays on this priority's Up.
    const up = within(priorities()).getByRole('button', { name: 'Move priority Later up' });
    await user.click(up);
    expect(await within(priorities()).findByText('Later moved up.')).toBeInTheDocument();
    expect(rowNames(priorities())).toEqual([
      'Urgent',
      'High',
      'Normal',
      'Low',
      'Later',
      'Very low',
    ]);
    expect(
      within(priorities()).getByRole('button', { name: 'Move priority Later up' }),
    ).toHaveFocus();
    const later = client.calls.find((c) => c.action === 'createPriority');
    expect(later?.args).toEqual([{ name: 'Someday', description: 'When there is time.' }]);
    // The whole list goes in its new order.
    expect(client.calls.at(-1)).toEqual({
      action: 'orderPriorities',
      args: [[1, 2, 3, 4, 101, 5]],
    });
  });

  it('[CORE-014] keeps the focus on a priority moved to the top', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Move priority High up' }));
    expect(await screen.findByText('High moved up.')).toBeInTheDocument();
    expect(rowNames(priorities()).slice(0, 2)).toEqual(['High', 'Urgent']);
    // Up is off at the top: Down holds the focus.
    expect(screen.getByRole('button', { name: 'Move priority High up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move priority High down' })).toHaveFocus();
  });

  it('[CORE-014] reads the list again when it changed elsewhere, and moves nothing', async () => {
    const user = userEvent.setup();
    const client = fakePrioritiesClient();
    renderPage(ADMIN, { client });
    await screen.findByText('Urgent');
    // Someone else adds a priority after the page read the list.
    await client.createPriority({ name: 'Elsewhere' });
    await user.click(screen.getByRole('button', { name: 'Move priority Low up' }));
    expect(await within(priorities()).findByRole('alert')).toHaveTextContent(
      'The list changed since this page read it, so nothing moved.',
    );
    expect(await within(priorities()).findByText('Elsewhere')).toBeVisible();
    expect(rowNames(priorities()).slice(2, 4)).toEqual(['Normal', 'Low']);
  });

  it('[CORE-014] refuses a name another priority has', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Change priority Low' }));
    const change = screen.getByRole('form', { name: 'Change priority Low' });
    await user.clear(within(change).getByLabelText('Name'));
    await user.type(within(change).getByLabelText('Name'), 'high');
    await user.click(within(change).getByRole('button', { name: 'Save' }));
    expect(await within(priorities()).findByRole('alert')).toHaveTextContent(
      'That name is taken. Choose another.',
    );
    // The form stays, with what was typed.
    expect(within(change).getByLabelText('Name')).toHaveValue('high');
  });

  it('[CORE-014] deletes a priority no ticket has, after asking', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const trigger = await screen.findByRole('button', { name: 'Delete priority Very low' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13); nothing is sent yet.
    const question = screen.getByRole('group', { name: /^Delete Very low\? If tickets have it/ });
    expect(client.calls).toEqual([]);
    await user.click(within(question).getByRole('button', { name: 'Delete priority Very low' }));
    expect(await within(priorities()).findByText('Very low was deleted.')).toBeInTheDocument();
    expect(rowNames(priorities())).toEqual(['Urgent', 'High', 'Normal', 'Low']);
    expect(screen.getByRole('heading', { name: 'Priorities, most urgent first' })).toHaveFocus();
    expect(client.calls).toEqual([{ action: 'deletePriority', args: [5, undefined] }]);
  });

  it('[CORE-014] asks which priority takes the place of one tickets have (3)', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete priority High' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete priority High' }),
    );
    const form = await screen.findByRole('form', { name: 'What takes the place of High' });
    expect(within(form).getByText(/^4 tickets have High\. Choose the priority/)).toBeVisible();
    const choice = within(form).getByLabelText('Instead, give them');
    expect(choice).toHaveFocus();
    expect(
      within(choice)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Urgent', 'Normal', 'Low', 'Very low']);
    // Cancel goes back to the priority's own Delete.
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete priority High' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete priority High' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete priority High' }),
    );
    const again = await screen.findByRole('form', { name: 'What takes the place of High' });
    await user.selectOptions(within(again).getByLabelText('Instead, give them'), 'Normal');
    await user.click(within(again).getByRole('button', { name: 'Delete priority High' }));
    expect(
      await within(priorities()).findByText('High was deleted; its tickets have Normal now.'),
    ).toBeInTheDocument();
    expect(client.calls.map((c) => c.args)).toEqual([
      [2, undefined],
      [2, undefined],
      [2, 3],
    ]);
    // Support offered High and gave it to new tickets: it offers and gives Normal now.
    expect(
      within(sets()).getByText(
        'Offers Urgent and Normal. New tickets get Normal. 1 track uses it.',
      ),
    ).toBeVisible();
  });

  it('[CORE-014] adds a priority set offering some priorities, with a default (2)', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await screen.findByText('Support');
    await user.click(within(sets()).getByRole('button', { name: 'New priority set' }));
    const form = within(sets()).getByRole('form', { name: 'Add a priority set' });
    const add = within(form).getByRole('button', { name: 'Add a priority set' });
    // Nothing offered yet: nothing to add.
    expect(add).toBeDisabled();
    await user.type(within(form).getByLabelText('Set name'), 'Ops');
    const offers = within(form).getByRole('group', { name: 'Priorities it offers' });
    await user.click(within(offers).getByLabelText('Low'));
    await user.click(within(offers).getByLabelText('Urgent'));
    const fallback = within(form).getByLabelText('New tickets get');
    // In the site's order, whatever the order they were ticked in.
    expect(
      within(fallback)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['The middle of what it offers', 'Urgent', 'Low']);
    await user.selectOptions(fallback, 'Low');
    // Unticked, it is no longer what new tickets get.
    await user.click(within(offers).getByLabelText('Low'));
    expect(fallback).toHaveValue('');
    await user.click(within(offers).getByLabelText('Low'));
    await user.selectOptions(fallback, 'Low');
    await user.click(add);
    expect(await within(sets()).findByText('Ops was added.')).toBeInTheDocument();
    expect(client.calls).toEqual([
      {
        action: 'createPrioritySet',
        args: [{ name: 'Ops', description: '', priorityIds: [1, 4], defaultPriorityId: 4 }],
      },
    ]);
    expect(
      within(sets()).getByText('Offers Urgent and Low. New tickets get Low. No track uses it.'),
    ).toBeVisible();
  });

  it('[CORE-014] changes a set, makes it the default, and keeps the default from deletion', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage priority set Support' }));
    const form = within(sets()).getByRole('form', { name: 'Change priority set Support' });
    await user.click(within(form).getByLabelText('Low'));
    await user.selectOptions(within(form).getByLabelText('New tickets get'), '');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(sets()).findByText('Support was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'updatePrioritySet',
      args: [
        2,
        {
          name: 'Support',
          description: 'For the help desk tracks.',
          priorityIds: [1, 2, 3, 4],
          defaultPriorityId: null,
        },
      ],
    });
    expect(
      within(sets()).getByText(
        'Offers Urgent, High, Normal, and Low. New tickets get the middle one. 1 track uses it.',
      ),
    ).toBeVisible();

    await user.click(within(sets()).getByRole('button', { name: 'Make Support the default set' }));
    expect(
      await within(sets()).findByText(
        'Support is the default set now. Tracks that choose no set offer its priorities.',
      ),
    ).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'updatePrioritySet',
      args: [2, { isDefault: true }],
    });
    // The default set offers no Delete and no Make default; it says why.
    expect(
      within(sets()).queryByRole('button', { name: 'Delete priority set Support' }),
    ).toBeNull();
    expect(within(sets()).getByText(/^Tracks that choose no set use this one\./)).toBeVisible();
    // The button that had the keyboard is gone: the note drawn in its place takes it.
    await waitFor(() =>
      expect(within(sets()).getByText(/^Tracks that choose no set use this one\./)).toHaveFocus(),
    );
    const badge = within(sets()).getByText('Default set');
    expect(badge.closest('li')).toHaveTextContent(/^Support/);
  });

  it('[CORE-014] says where a deleted set’s tracks go before deleting it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage priority set Support' }));
    await user.click(within(sets()).getByRole('button', { name: 'Delete priority set Support' }));
    const question = within(sets()).getByRole('group', {
      name: 'Delete Support? The 1 track that uses it goes back to the default set, Default priority set. This cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete priority set Support' }));
    expect(await within(sets()).findByText('Support was deleted.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Priority sets' })).toHaveFocus();
    expect(rowNames(sets())).toEqual(['Default priority setDefault set']);
    expect(within(sets()).getByText(/4 tracks use it\.$/)).toBeVisible();
    expect(client.calls).toEqual([{ action: 'deletePrioritySet', args: [2] }]);
  });

  it('[CORE-014] links to where a track chooses its set', async () => {
    renderPage();
    await screen.findByText('Support');
    expect(
      within(sets()).getByRole('link', {
        name: 'Choose a track’s set on Which sets a track uses.',
      }),
    ).toHaveAttribute('href', '#/admin/track-sets');
  });

  it('[CORE-014] adds, renames and moves a close reason', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await screen.findByText('Completed');
    expect(rowNames(reasons())).toEqual([
      'Completed',
      'Not planned',
      'Duplicate',
      'Not reproducible',
    ]);
    await user.click(within(reasons()).getByRole('button', { name: 'New close reason' }));
    const form = within(reasons()).getByRole('form', { name: 'Add a close reason' });
    await user.type(within(form).getByLabelText('Name'), 'Out of scope');
    await user.click(within(form).getByRole('button', { name: 'Add a close reason' }));
    expect(await within(reasons()).findByText('Out of scope was added.')).toBeInTheDocument();
    await user.click(
      within(reasons()).getByRole('button', { name: 'Move close reason Out of scope up' }),
    );
    expect(await within(reasons()).findByText('Out of scope moved up.')).toBeInTheDocument();
    expect(rowNames(reasons())).toEqual([
      'Completed',
      'Not planned',
      'Duplicate',
      'Out of scope',
      'Not reproducible',
    ]);
    await user.click(
      within(reasons()).getByRole('button', { name: 'Change close reason Duplicate' }),
    );
    const change = within(reasons()).getByRole('form', { name: 'Change close reason Duplicate' });
    expect(within(change).getByLabelText('Description (optional)')).toHaveValue(
      'Another ticket covers it.',
    );
    await user.clear(within(change).getByLabelText('Name'));
    await user.type(within(change).getByLabelText('Name'), 'Already asked');
    await user.click(within(change).getByRole('button', { name: 'Save' }));
    expect(await within(reasons()).findByText('Already asked was saved.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.action)).toEqual([
      'createCloseReason',
      'orderCloseReasons',
      'updateCloseReason',
    ]);
  });

  it('[CORE-014] names the workflows that set a close reason, and replaces it in them (3)', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const trigger = await screen.findByRole('button', { name: 'Delete close reason Duplicate' });
    await user.click(trigger);
    // Before anything is sent, the question says workflows that set it get a new version.
    const question = screen.getByRole('group', {
      name: 'Delete Duplicate? If tickets were closed with it, or a workflow sets it, you choose next which reason takes its place, and each workflow that sets Duplicate gets a new version that sets that one. This cannot be undone.',
    });
    await user.click(
      within(question).getByRole('button', { name: 'Delete close reason Duplicate' }),
    );
    const form = await screen.findByRole('form', { name: 'What takes the place of Duplicate' });
    expect(
      within(form).getByText(
        'The workflow Support flow sets Duplicate. Choose the reason to set instead: each of them gets a new version that sets it.',
      ),
    ).toBeVisible();
    await user.selectOptions(within(form).getByLabelText('Instead, give them'), 'Not planned');
    await user.click(within(form).getByRole('button', { name: 'Delete close reason Duplicate' }));
    expect(
      await within(reasons()).findByText('Duplicate was deleted; Not planned takes its place.'),
    ).toBeInTheDocument();
    expect(client.calls.map((c) => c.args)).toEqual([
      [3, undefined],
      [3, 2],
    ]);
  });

  it('[CORE-014] asks for another close reason for the tickets closed with one (3)', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Delete close reason Not planned' }),
    );
    await user.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Delete close reason Not planned',
      }),
    );
    const form = await screen.findByRole('form', { name: 'What takes the place of Not planned' });
    expect(within(form).getByText(/^2 tickets were closed with Not planned\./)).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Delete close reason Not planned' }));
    expect(
      await within(reasons()).findByText('Not planned was deleted; Completed takes its place.'),
    ).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ action: 'deleteCloseReason', args: [2, 1] });
  });

  it('[IAM-009] lets a configuration administrator change them', async () => {
    const user = userEvent.setup();
    const client = renderPage(CONFIG_ADMIN);
    await user.click(await screen.findByRole('button', { name: 'Move priority Low down' }));
    expect(await screen.findByText('Low moved down.')).toBeInTheDocument();
    expect(client.calls).toEqual([{ action: 'orderPriorities', args: [[1, 2, 3, 5, 4]] }]);
  });

  it('[IAM-009] says so when the server refuses a change', async () => {
    const user = userEvent.setup();
    const client = fakePrioritiesClient();
    client.updateCloseReason = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    renderPage(CONFIG_ADMIN, { client });
    await user.click(await screen.findByRole('button', { name: 'Change close reason Completed' }));
    const change = screen.getByRole('form', { name: 'Change close reason Completed' });
    await user.type(within(change).getByLabelText('Description (optional)'), 'Done.');
    await user.click(within(change).getByRole('button', { name: 'Save' }));
    expect(await within(reasons()).findByRole('alert')).toHaveTextContent(
      'You may no longer change these.',
    );
  });

  it.each([
    ['a member', MEMBER],
    ['someone who only runs tracks', TRACK_ADMIN],
  ])('[IAM-009] refuses %s, and reads nothing', (_, session) => {
    const client = renderPage(session);
    expect(
      screen.getByText(
        'Only site and configuration administrators change priorities and close reasons.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Priority sets' })).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('says when the lists cannot be read', async () => {
    const client = fakePrioritiesClient();
    client.closeReasons = async () => {
      throw new ApiError(500, null);
    };
    renderPage(ADMIN, { client });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The priorities could not be read. Try again in a moment.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Priorities' })).toBeVisible();
  });

  it('explains an empty list of close reasons', async () => {
    const client = fakePrioritiesClient();
    client.closeReasons = async () => [];
    renderPage(ADMIN, { client });
    expect(
      await within(await screen.findByRole('region', { name: 'Close reasons' })).findByText(
        'There are no close reasons.',
      ),
    ).toBeVisible();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'Manage priority set Support' }),
    ).toBeVisible();
  });

  it('[NFR-006] reads in Spanish', async () => {
    renderPage(ADMIN, { locale: 'es' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Prioridades' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Conjuntos de prioridades' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Subir la prioridad High' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set([
      'Urgent',
      'High',
      'Normal',
      'Low',
      'Very low',
      'Drop everything.',
      'Default priority set',
      'Support',
      'For the help desk tracks.',
      'Completed',
      'Not planned',
      'Duplicate',
      'Another ticket covers it.',
      'Not reproducible',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

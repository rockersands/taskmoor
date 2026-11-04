import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, CONFIG_ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { currentRoute, router } from '../routing/router';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type FakeLayoutsClient, fakeLayoutsClient } from './fixtures';
import { LayoutEditorPage } from './LayoutEditorPage';

function renderPage(
  session: Session = CONFIG_ADMIN,
  props: { client?: FakeLayoutsClient; initialSetId?: number; locale?: Locale } = {},
) {
  const client = props.client ?? fakeLayoutsClient();
  render(
    <I18nProvider locale={props.locale ?? 'en'}>
      <SessionProvider session={session}>
        <main>
          <LayoutEditorPage
            client={client}
            previewDelay={0}
            {...(props.initialSetId ? { initialSetId: props.initialSetId } : {})}
          />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

const editor = (name = 'Default layouts') =>
  screen.findByRole('form', { name: `Layouts of ${name}` });
const group = (name: string) => screen.getByRole('group', { name });
const MAIN = 'Details, section 1: main column';
const SIDE = 'Details, section 2: side column';
/** The fields a section holds, by name, in order. */
const fieldsIn = (section: string) =>
  within(group(section))
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('.layout-field-name')?.textContent);
const palette = () => screen.getByRole('region', { name: 'Fields not placed' });
const unplaced = () =>
  within(palette())
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('.layout-field-name')?.textContent);
const preview = () => screen.getByRole('region', { name: 'Preview' });
/** The fields the preview shows, by label, in order. */
const previewed = () =>
  [...preview().querySelectorAll('.layout-preview-label')].map(
    (label) => label.firstChild?.textContent,
  );

/** Picks a move from a grip's menu, as a keyboard or a pointer would. */
async function choose(user: ReturnType<typeof userEvent.setup>, grip: string, move: string) {
  await user.click(screen.getByRole('button', { name: grip }));
  await user.click(screen.getByRole('menuitem', { name: move }));
}

/**
 * A drag with pointer events, as a mouse or a finger makes it: down on a grip, moves over the
 * page, up over the target. jsdom lays nothing out, so what is under the pointer is the element
 * the test names.
 */
function dragTo(from: HTMLElement, to: Element, pointerType: 'mouse' | 'touch' = 'mouse') {
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(to);
  const point = { pointerId: 9, pointerType, isPrimary: true };
  fireEvent.pointerDown(from, { ...point, button: 0, clientX: 100, clientY: 200 });
  fireEvent.pointerMove(window, { ...point, clientX: 140, clientY: 260 });
  fireEvent.pointerMove(window, { ...point, clientX: 180, clientY: 320 });
  fireEvent.pointerUp(window, { ...point, clientX: 180, clientY: 320 });
  under.mockRestore();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the layout editor (UI-T15)', () => {
  it('[CORE-008] shows the default set’s form: placed fields by tab and section, the rest, and a preview', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Layout sets' })).toBeVisible();
    await editor();
    expect(screen.getByLabelText('Layout set')).toHaveValue('1');
    expect(screen.getByRole('option', { name: 'Default layouts (default)' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Ops layouts (a track’s own)' })).toBeVisible();
    expect(screen.getByText(/Used by SHOP\./)).toBeVisible();
    expect(
      screen.getByText('The create form for every ticket type has a layout of its own.'),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Tab 1: Details' })).toBeVisible();
    expect(fieldsIn(MAIN)).toEqual(['Summary', 'Description', 'Priority']);
    expect(fieldsIn(SIDE)).toEqual(['Assignee', 'Due date']);
    expect(within(group(SIDE)).getByLabelText('Hide when empty')).toBeChecked();
    expect(within(group(SIDE)).getByLabelText('Column')).toHaveValue('context');
    // Shared fields only: the OPS track's own field is not for a shared set.
    expect(unplaced()).toContain('Labels');
    expect(unplaced()).toContain('Severity');
    expect(unplaced()).not.toContain('Ops notes');
    // The preview: Feature's create form, the summary required, the rest after the layout.
    expect(
      await within(preview()).findByText('Preview of the create form for Feature'),
    ).toBeVisible();
    expect(
      within(preview()).getByText('Feature uses the layout for every ticket type.'),
    ).toBeVisible();
    expect(previewed().slice(0, 5)).toEqual([
      'Summary',
      'Description',
      'Priority',
      'Assignee',
      'Due date',
    ]);
    expect(within(preview()).getByRole('heading', { name: 'More fields' })).toBeVisible();
    expect(previewed()).not.toContain('Environment');
    expect(within(preview()).getAllByText('Required')).toHaveLength(1);
    expect(within(preview()).getByText('How bad it is')).toBeVisible();
  });

  it('[CORE-008] moves fields with the keyboard: Alt and the arrows, and each grip’s menu, each move announced', async () => {
    const user = userEvent.setup();
    renderPage();
    await editor();
    const summary = screen.getByRole('button', { name: 'Move Summary' });
    summary.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(fieldsIn(MAIN)).toEqual(['Description', 'Summary', 'Priority']);
    expect(
      await screen.findByText('Summary: place 2 of 3 in Details, section 1: main column.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Summary' })).toHaveFocus();
    // From the end of the main column, a step later goes into the side column.
    await user.keyboard('{Alt>}{ArrowDown}{ArrowDown}{/Alt}');
    expect(fieldsIn(SIDE)).toEqual(['Summary', 'Assignee', 'Due date']);
    expect(screen.getByRole('button', { name: 'Move Summary' })).toHaveFocus();
    // The menu: across sections, from the list of fields not placed, and back to it.
    await choose(user, 'Move Priority', `Move to ${SIDE}`);
    expect(fieldsIn(SIDE)).toEqual(['Summary', 'Assignee', 'Due date', 'Priority']);
    expect(screen.getByRole('button', { name: 'Move Priority' })).toHaveFocus();
    await choose(user, 'Place Labels', `Put in ${MAIN}`);
    expect(fieldsIn(MAIN)).toEqual(['Description', 'Labels']);
    expect(unplaced()).not.toContain('Labels');
    expect(
      await screen.findByText('Labels: place 2 of 2 in Details, section 1: main column.'),
    ).toBeInTheDocument();
    await choose(user, 'Move Labels', 'Take off the layout');
    expect(unplaced()).toContain('Labels');
    expect(await screen.findByText('Labels is off the layout.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place Labels' })).toHaveFocus();
    // The preview follows the draft before anything is saved.
    await waitFor(() => expect(previewed().slice(0, 2)).toEqual(['Description', 'Summary']));
  });

  it('[CORE-008] a mouse or a finger drags fields in, between sections and back, and sections and tabs into place', async () => {
    const user = userEvent.setup();
    renderPage();
    await editor();
    // From the list into the side column, dropped on the section: last.
    dragTo(screen.getByRole('button', { name: 'Place Labels' }), group(SIDE));
    expect(fieldsIn(SIDE)).toEqual(['Assignee', 'Due date', 'Labels']);
    expect(
      await screen.findByText('Labels: place 3 of 3 in Details, section 2: side column.'),
    ).toBeInTheDocument();
    // Onto a field: beside it (jsdom has no boxes, so after it).
    const description = within(group(MAIN))
      .getAllByRole('listitem')
      .find((li) => li.textContent === 'Description') as HTMLElement;
    dragTo(screen.getByRole('button', { name: 'Move Due date' }), description, 'touch');
    expect(fieldsIn(MAIN)).toEqual(['Summary', 'Description', 'Due date', 'Priority']);
    // Back to the list.
    dragTo(screen.getByRole('button', { name: 'Move Priority' }), palette());
    expect(unplaced()).toContain('Priority');
    // A section onto the other takes its place.
    dragTo(screen.getByRole('button', { name: `Move ${SIDE}` }), group(MAIN));
    expect(fieldsIn('Details, section 1: side column')).toEqual(['Assignee', 'Labels']);
    // A new tab, then dragged before the first.
    await user.click(screen.getByRole('button', { name: 'Add a tab' }));
    const second = screen.getByRole('group', { name: 'Tab 2: Tab 2' });
    dragTo(within(second).getByRole('button', { name: 'Move tab Tab 2' }), group('Tab 1: Details'));
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['Tab 1: Tab 2', 'Tab 2: Details']),
    );
    // A press that does not move is a press: it opens the menu.
    await user.click(screen.getByRole('button', { name: 'Move Summary' }));
    expect(screen.getByRole('menu')).toBeVisible();
  });

  it('[CORE-013] adds, renames, reorders and removes tabs and sections, giving fields back', async () => {
    const user = userEvent.setup();
    renderPage();
    await editor();
    await user.click(screen.getByRole('button', { name: 'Add a tab' }));
    const fresh = screen.getAllByRole('textbox', { name: 'Tab name' }).at(-1) as HTMLElement;
    expect(fresh).toHaveFocus();
    expect(await screen.findByText('Added tab Tab 2.')).toBeInTheDocument();
    await user.clear(fresh);
    await user.type(fresh, 'Planning');
    expect(screen.getByRole('heading', { level: 2, name: 'Tab 2: Planning' })).toBeVisible();
    // A section in the new tab, made a side column that hides when empty.
    await user.click(screen.getByRole('button', { name: 'Add a section to Planning' }));
    expect(
      screen.getByRole('button', { name: 'Move Planning, section 2: main column' }),
    ).toHaveFocus();
    const added = group('Planning, section 2: main column');
    await user.selectOptions(within(added).getByLabelText('Column'), 'Side column');
    await user.click(
      within(group('Planning, section 2: side column')).getByLabelText('Hide when empty'),
    );
    await choose(user, 'Place Start date', 'Put in Planning, section 2: side column');
    expect(fieldsIn('Planning, section 2: side column')).toEqual(['Start date']);
    // Planning goes first, by its grip's menu.
    await choose(user, 'Move tab Planning', 'Move earlier');
    expect(await screen.findByText('Tab Planning: place 1 of 2.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tab 1: Planning' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move tab Planning' })).toHaveFocus();
    // A section to the other tab, then removed: its fields go back.
    await choose(user, 'Move Planning, section 2: side column', 'Move to tab Details');
    expect(fieldsIn('Details, section 3: side column')).toEqual(['Start date']);
    await user.click(
      screen.getByRole('button', { name: 'Remove Details, section 3: side column' }),
    );
    expect(unplaced()).toContain('Start date');
    expect(screen.getByRole('button', { name: 'Add a section to Details' })).toHaveFocus();
    // Removing a tab gives its fields back as well.
    await user.click(screen.getByRole('button', { name: 'Remove tab Details' }));
    expect(unplaced()).toEqual(expect.arrayContaining(['Summary', 'Assignee', 'Due date']));
    expect(screen.getByRole('button', { name: 'Add a tab' })).toHaveFocus();
    // A grip with nowhere to go says so.
    await user.click(screen.getByRole('button', { name: 'Move tab Planning' }));
    expect(screen.getByRole('menuitem', { name: 'Nowhere to move it yet' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('[CORE-013] saves the set’s layouts as a whole, with only the fields placed, and holds the set until then', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await editor();
    await choose(user, 'Place Labels', `Put in ${MAIN}`);
    await user.click(within(form).getByLabelText('Show only the fields I placed'));
    expect(within(form).getByText('Unsaved changes')).toBeVisible();
    expect(screen.getByLabelText('Layout set')).toBeDisabled();
    expect(
      screen.getByText('Save or discard your changes to choose or add another set.'),
    ).toBeVisible();
    // The preview leaves out what is not placed, except what is required.
    await waitFor(() => expect(previewed()).not.toContain('Severity'));
    await user.click(within(form).getByRole('button', { name: 'Save the layouts' }));
    expect(await screen.findByText('Default layouts was saved.')).toBeInTheDocument();
    expect(client.saved).toEqual([
      {
        id: 1,
        change: {
          layouts: [
            {
              ticketTypeId: null,
              operation: 'create',
              definition: {
                others: 'omit',
                tabs: [
                  {
                    name: 'Details',
                    sections: [
                      {
                        kind: 'main',
                        hideWhenEmpty: false,
                        fields: ['summary', 'description', 'priority', 'labels'],
                      },
                      { kind: 'context', hideWhenEmpty: true, fields: ['assignee', 'dueDate'] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(within(form).queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByLabelText('Layout set')).toBeEnabled();
    // Discard goes back to what was saved.
    await choose(user, 'Move Labels', 'Take off the layout');
    await user.click(within(form).getByRole('button', { name: 'Discard changes' }));
    expect(fieldsIn(MAIN)).toEqual(['Summary', 'Description', 'Priority', 'Labels']);
    expect(within(form).getByRole('button', { name: 'Save the layouts' })).toBeDisabled();
  });

  it('[CORE-008] gives one ticket type a layout of its own from the one for every type, and takes it away', async () => {
    const user = userEvent.setup();
    const client = renderPage(ADMIN);
    const form = await editor();
    await user.selectOptions(within(form).getByLabelText('Ticket type'), 'Bug');
    expect(
      within(form).getByText(
        'The create form for Bug uses the layout for every ticket type. Make one of its own to arrange it differently.',
      ),
    ).toBeVisible();
    expect(within(form).queryByRole('region', { name: 'Fields not placed' })).toBeNull();
    // The preview shows Bug's form: its due date is required by a field rule.
    await waitFor(() => expect(within(preview()).getAllByText('Required')).toHaveLength(2));
    expect(within(preview()).queryByLabelText('Preview as')).toBeNull();
    await user.click(
      within(form).getByRole('button', { name: 'Make its own layout from the one for every type' }),
    );
    expect(fieldsIn(MAIN)).toEqual(['Summary', 'Description', 'Priority']);
    expect(within(form).getByRole('option', { name: 'Bug (own layout)' })).toBeInTheDocument();
    await choose(user, 'Move Priority', 'Take off the layout');
    expect(await within(preview()).findByText('Bug uses its own layout.')).toBeVisible();
    // The other operations of the same type are separate forms.
    await user.click(within(form).getByRole('radio', { name: 'View' }));
    expect(
      within(form).getByText(
        'The view form for Bug has no layout: it shows every field that applies, in one tab.',
      ),
    ).toBeVisible();
    await user.click(within(form).getByRole('radio', { name: 'Create' }));
    await user.click(within(form).getByRole('button', { name: 'Remove this type’s layout' }));
    expect(within(form).getByRole('option', { name: 'Bug' })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save the layouts' })).toBeDisabled();
    expect(client.saved).toEqual([]);
  });

  it('[CORE-008] the preview says what a rule leaves out, per track, and keeps a form a server would refuse off the save', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await editor();
    await choose(user, 'Place Environment', `Put in ${SIDE}`);
    expect(await within(preview()).findByText('Environment: a field rule hides it.')).toBeVisible();
    await choose(user, 'Place Customer', `Put in ${SIDE}`);
    await waitFor(() => expect(previewed()).toContain('Customer'));
    // SHOP's rules hide Customer.
    await user.selectOptions(within(preview()).getByLabelText('Fields and rules of'), 'SHOP: Shop');
    expect(await within(preview()).findByText('Customer: a field rule hides it.')).toBeVisible();
    expect(client.previews.at(-1)).toMatchObject({ ticketTypeId: 1, trackId: 3 });
    // A tab with no name: said at once, by the server's preview too, and no save is sent.
    const tabName = within(form).getByRole('textbox', { name: 'Tab name' });
    await user.clear(tabName);
    expect(within(form).getAllByText('Every tab needs a name.')[0]).toBeVisible();
    expect(
      await within(preview()).findByText('The server would refuse this layout as it is:'),
    ).toBeVisible();
    expect(within(preview()).getByText(/a name is needed/)).toBeVisible();
    // The last good form stays in view meanwhile.
    expect(previewed()).toContain('Summary');
    await user.click(within(form).getByRole('button', { name: 'Save the layouts' }));
    expect(client.saved).toEqual([]);
  });

  it('[CORE-013] adds a set and deletes it; a set a track uses stays, and says why', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await editor();
    const add = screen.getByRole('form', { name: 'Add a layout set' });
    await user.type(within(add).getByLabelText('New set name'), 'Release layouts');
    await user.click(within(add).getByRole('button', { name: 'Add a layout set' }));
    expect(await screen.findByText('Release layouts was added.')).toBeInTheDocument();
    const made = await editor('Release layouts');
    expect(within(made).getByText('No track uses this set yet.')).toBeVisible();
    expect(
      within(made).getByText(
        'The create form for every ticket type has no layout: it shows every field that applies, in one tab.',
      ),
    ).toBeVisible();
    await user.click(within(made).getByRole('button', { name: 'Make a layout for this form' }));
    expect(fieldsIn(MAIN)).toEqual([]);
    expect(within(made).getAllByText(/No fields yet/)).toHaveLength(2);
    await user.click(within(made).getByRole('button', { name: 'Discard changes' }));
    await user.click(within(made).getByRole('button', { name: 'Delete set Release layouts' }));
    await user.click(within(made).getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Release layouts was deleted.')).toBeInTheDocument();
    expect(await editor()).toBeVisible();
    expect(client.sets.map((s) => s.name)).not.toContain('Release layouts');
    // The default set offers no delete; a set in use is refused by the server.
    expect(screen.queryByRole('button', { name: /^Delete set/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Layout set'), 'Ops layouts (a track’s own)');
    const ops = await editor('Ops layouts');
    await user.click(within(ops).getByRole('button', { name: 'Delete set Ops layouts' }));
    await user.click(within(ops).getByRole('button', { name: 'Yes, delete' }));
    expect(await within(ops).findByRole('alert')).toHaveTextContent(
      '1 track uses this set: give them another on Which sets a track uses first.',
    );
  });

  it('[CORE-008] a track’s own set places its own fields and previews that track by default', async () => {
    const client = renderPage(CONFIG_ADMIN, { initialSetId: 5 });
    await editor('Ops layouts');
    expect(screen.getByLabelText('Layout set')).toHaveValue('5');
    expect(screen.getByText(/Used by OPS\./)).toBeVisible();
    expect(screen.getAllByRole('option', { name: 'Runbook' })).not.toHaveLength(0);
    expect(within(preview()).getByLabelText('Fields and rules of')).toHaveValue('4');
    await waitFor(() => expect(client.previews.at(-1)).toMatchObject({ trackId: 4 }));
  });

  it('links to the field rules and says how the two combine', async () => {
    renderPage();
    await editor();
    expect(
      screen.getByText(/a hidden field never appears, even where a layout places it/),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Field rules are on Configuration sets.' }),
    ).toHaveAttribute('href', '#/admin/configuration-sets');
  });

  it('[IAM-009] refuses someone who is neither kind of administrator', () => {
    const client = renderPage(MEMBER);
    expect(
      screen.getByText('Only site and configuration administrators change layouts.'),
    ).toBeVisible();
    expect(client.previews).toEqual([]);
  });

  it('says when the sets cannot be read', async () => {
    const client = fakeLayoutsClient();
    client.layoutSets = async () => {
      throw new Error('offline');
    };
    renderPage(ADMIN, { client });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await editor()).toBeVisible();
    expect(screen.getByRole('region', { name: 'Preview' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findByRole('form', { name: /Default layouts/ });
    await waitFor(() => expect(main.querySelector('.layout-preview-form')).not.toBeNull());
    const data = new Set([
      'Default layouts',
      'Support layouts',
      'Ops layouts',
      'Details',
      'Feature',
      'Bug',
      'Chore',
      'Severity',
      'Customer',
      'How bad it is',
    ]);
    expect(untranslated(visibleTexts(main)).filter((t) => !data.has(t))).toEqual([]);
  });
});

describe('unsaved layouts are never lost in silence (UI-T15)', () => {
  let stop = () => {};
  beforeEach(() => {
    window.history.replaceState(null, '', '/#/admin');
    window.history.pushState(null, '', '/#/admin/layouts');
    stop = router.start();
  });
  afterEach(() => {
    stop();
    cleanup();
  });

  function renderWithNav() {
    const client = fakeLayoutsClient();
    render(
      <I18nProvider locale="en">
        <SessionProvider session={CONFIG_ADMIN}>
          <nav>
            <a href="#/admin/tracks">Tracks</a>
            <a href="#/admin/layouts?set=2">Support layouts</a>
          </nav>
          <main>
            <LayoutEditorPage client={client} previewDelay={0} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    return client;
  }
  const asked = () =>
    screen.findByRole('alertdialog', { name: 'Discard your changes to these layouts?' });
  /** Whether closing or reloading the tab would make the browser ask. */
  const unloadAsks = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('[NFR-005] a link out of the page asks first; keeping loses nothing and discarding leaves', async () => {
    const user = userEvent.setup();
    renderWithNav();
    await editor();
    expect(unloadAsks()).toBe(false);
    await choose(user, 'Place Labels', `Put in ${MAIN}`);
    expect(unloadAsks()).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Tracks' }));
    const dialog = await asked();
    expect(dialog).toHaveTextContent('Default layouts has changes you have not saved.');
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fieldsIn(MAIN)).toContain('Labels');
    expect(currentRoute()).toBe('#/admin/layouts');

    await user.click(screen.getByRole('link', { name: 'Tracks' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Discard them' }));
    await waitFor(() => expect(currentRoute()).toBe('#/admin/tracks'));
  });

  it('[NFR-005] adding a set waits for the draft, since the new set would open in its place', async () => {
    const user = userEvent.setup();
    const client = renderWithNav();
    await editor();
    const add = screen.getByRole('form', { name: 'Add a layout set' });
    const newName = within(add).getByLabelText('New set name');
    await user.type(newName, 'Release layouts');
    await choose(user, 'Place Labels', `Put in ${MAIN}`);
    const button = within(add).getByRole('button', { name: 'Add a layout set' });
    expect(newName).toBeDisabled();
    expect(button).toBeDisabled();
    const why = 'Save or discard your changes to choose or add another set.';
    expect(newName).toHaveAccessibleDescription(why);
    expect(button).toHaveAccessibleDescription(why);
    fireEvent.submit(add);
    expect(client.sets.map((s) => s.name)).not.toContain('Release layouts');
    expect(fieldsIn(MAIN)).toContain('Labels');
    // Once the draft is discarded, adding works and opens the new set.
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(button).toBeEnabled();
    await user.click(button);
    expect(await editor('Release layouts')).toBeVisible();
  });

  it('[NFR-005] a draft begun while a set is being added stays open', async () => {
    const user = userEvent.setup();
    const client = renderWithNav();
    await editor();
    const create = client.createLayoutSet;
    let made = () => {};
    client.createLayoutSet = (body) =>
      new Promise((resolve, reject) => {
        made = () => create(body).then(resolve, reject);
      });
    const add = screen.getByRole('form', { name: 'Add a layout set' });
    await user.type(within(add).getByLabelText('New set name'), 'Release layouts');
    await user.click(within(add).getByRole('button', { name: 'Add a layout set' }));
    await choose(user, 'Place Labels', `Put in ${MAIN}`);
    made();
    expect(await screen.findByText('Release layouts was added.')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Release layouts' })).toBeInTheDocument();
    expect(screen.getByLabelText('Layout set')).toHaveValue('1');
    expect(await editor()).toBeVisible();
    expect(fieldsIn(MAIN)).toContain('Labels');
    expect(screen.getByText('Unsaved changes')).toBeVisible();
  });

  it('[NFR-005] with nothing changed, or within the page, nothing is asked', async () => {
    const user = userEvent.setup();
    renderWithNav();
    await editor();
    await user.click(screen.getByRole('link', { name: 'Support layouts' }));
    await waitFor(() => expect(currentRoute()).toBe('#/admin/layouts?set=2'));
    await choose(user, 'Place Labels', `Put in ${MAIN}`);
    await user.click(screen.getByRole('button', { name: 'Save the layouts' }));
    expect(await screen.findByText('Default layouts was saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Tracks' }));
    await waitFor(() => expect(currentRoute()).toBe('#/admin/tracks'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

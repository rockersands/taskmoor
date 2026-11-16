import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type FakeTicketTypesClient, fakeTicketTypesClient } from './fixtures';
import { TicketTypesPage } from './TicketTypesPage';

function renderPage(
  options: { session?: Session; locale?: Locale; client?: FakeTicketTypesClient } = {},
) {
  const client = options.client ?? fakeTicketTypesClient();
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <SessionProvider session={options.session ?? ADMIN}>
        <main>
          <TicketTypesPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

const levelHeadings = () =>
  screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
const card = (level: string) => screen.getByRole('region', { name: level });
const writes = (client: FakeTicketTypesClient) =>
  client.calls.map((call) => [call.action, ...call.args]);

describe('ticket types and levels (T-320)', () => {
  it('[CORE-006] shows the levels top first, each with its types, and adds a level where no parent link breaks', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await screen.findByRole('heading', { level: 2, name: 'Portfolio' });
    expect(levelHeadings()).toEqual([
      'Portfolio',
      'Initiative',
      'Outcome',
      'Standard',
      'Subticket',
    ]);
    expect(
      within(card('Standard'))
        .getAllByRole('button', { name: /^Manage ticket type / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Manage ticket type Bug',
      'Manage ticket type Chore',
      'Manage ticket type Feature',
      'Manage ticket type Spike',
    ]);
    expect(
      within(card('Outcome')).getByText('Built in: it can be renamed, not moved or removed.'),
    ).toBeVisible();
    expect(
      within(card('Initiative')).getByText('Several outcomes that move one goal'),
    ).toBeVisible();

    // New level opens its form; the top is where it goes unless another place is chosen.
    const opener = screen.getByRole('button', { name: 'New level' });
    await user.click(opener);
    const form = screen.getByRole('form', { name: 'Add a level' });
    const place = within(form).getByLabelText('Where it goes');
    expect(
      within(place)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Above Portfolio', 'Above Initiative', 'Above Outcome']);
    expect(place).toHaveAccessibleDescription(
      'Tickets of the new level can be the parents of tickets of the level just below it.',
    );
    await user.type(within(form).getByLabelText('Level name'), 'Theme');
    // Right above Outcome, Initiative would move up and its tickets could no longer parent outcomes.
    await user.selectOptions(place, 'Above Outcome');
    await user.click(within(form).getByRole('button', { name: 'Add a level' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing changed: 3 parent links would break',
    );
    await user.selectOptions(place, 'Above Initiative');
    await user.click(within(form).getByRole('button', { name: 'Add a level' }));
    expect(await screen.findByText('The level Theme was added.')).toBeInTheDocument();
    await screen.findByRole('heading', { level: 2, name: 'Theme' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a level' })).toBeNull();
    expect(opener).toHaveFocus();
    expect(levelHeadings()).toEqual([
      'Portfolio',
      'Theme',
      'Initiative',
      'Outcome',
      'Standard',
      'Subticket',
    ]);
    expect(writes(client)).toEqual([
      ['createLevel', { name: 'Theme', rank: 2 }],
      ['createLevel', { name: 'Theme', rank: 3 }],
    ]);
  });

  it('[CORE-006] renames a built-in level and moves an added one, the keyboard staying on it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await screen.findByRole('heading', { level: 2, name: 'Standard' });
    // Built-in levels are renamed, never moved or removed.
    expect(within(card('Standard')).queryByRole('button', { name: /^Move level/ })).toBeNull();
    expect(within(card('Standard')).queryByRole('button', { name: /^Remove level/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Rename level Standard' }));
    const rename = screen.getByRole('form', { name: 'Rename level Standard' });
    const name = within(rename).getByLabelText('Level name');
    await user.clear(name);
    await user.type(name, 'Everyday');
    await user.click(within(rename).getByRole('button', { name: 'Save the level' }));
    expect(await screen.findByText('The level Everyday was saved.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Everyday' })).toBeVisible();
    // The form is gone with its Save button: Rename has the keyboard again.
    expect(screen.queryByRole('form', { name: /^Rename level/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename level Everyday' })).toHaveFocus();

    // A level added on top moves down below Portfolio and back.
    await user.click(screen.getByRole('button', { name: 'New level' }));
    const add = screen.getByRole('form', { name: 'Add a level' });
    await user.type(within(add).getByLabelText('Level name'), 'Theme');
    await user.click(within(add).getByRole('button', { name: 'Add a level' }));
    await screen.findByText('The level Theme was added.');
    expect(await screen.findByRole('button', { name: 'Move level Theme up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move level Theme down' }));
    expect(await screen.findByText('Theme moved down.')).toBeInTheDocument();
    await waitFor(() => expect(levelHeadings().slice(0, 2)).toEqual(['Portfolio', 'Theme']));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move level Theme down' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('button', { name: 'Move level Theme up' }));
    expect(await screen.findByText('Theme moved up.')).toBeInTheDocument();
    // At the top, Up is not offered: the keyboard goes to Down.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move level Theme up' })).toBeDisabled(),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move level Theme down' })).toHaveFocus(),
    );
    expect(writes(client)).toEqual([
      ['updateLevel', 2, { name: 'Everyday', description: '' }],
      ['createLevel', { name: 'Theme', rank: 4 }],
      ['updateLevel', 101, { rank: 3 }],
      ['updateLevel', 101, { rank: 4 }],
    ]);
  });

  it('[CORE-007] refuses a move that would break parent links, and says how many', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Move level Portfolio down' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing changed: 3 parent links would break, and no ticket would be left without the parent a subticket needs. Change those tickets’ parents first.',
    );
    expect(levelHeadings().slice(0, 2)).toEqual(['Portfolio', 'Initiative']);
  });

  it('[CORE-007] says what removing a level would do before it does, and keeps one that would break links', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    // Initiative's tickets parent outcomes: it is not offered for removal, and the card says why.
    expect(
      await within(await screen.findByRole('region', { name: 'Initiative' })).findByText(
        'Initiative cannot be removed now: 3 parent links would break, and no ticket would be left without the parent a subticket needs. Change those tickets’ parents first.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove level Initiative' })).toBeDisabled();

    // A type at Portfolio falls to the standard level with it.
    await user.click(screen.getByRole('button', { name: 'New ticket type' }));
    const add = screen.getByRole('form', { name: 'Add a ticket type' });
    await user.type(within(add).getByLabelText('Ticket type name'), 'Theme');
    await user.selectOptions(within(add).getByLabelText('Level'), 'Portfolio');
    await user.click(within(add).getByRole('button', { name: 'Add a ticket type' }));
    await screen.findByText('Theme was added.');
    await within(card('Portfolio')).findByRole('button', { name: 'Manage ticket type Theme' });
    const remove = within(card('Portfolio')).getByRole('button', {
      name: 'Remove level Portfolio',
    });
    await expect.poll(() => remove.hasAttribute('disabled')).toBe(false);
    expect(remove).toHaveClass('button-danger-quiet');
    await user.click(remove);
    const question = screen.getByRole('group', {
      name: 'Remove Portfolio? Its type, Theme, falls to the Standard level. No ticket changes level. This cannot be undone.',
    });
    expect(client.calls.map((c) => c.action)).toEqual(['createType']);
    await user.click(within(question).getByRole('button', { name: 'Remove level Portfolio' }));
    expect(await screen.findByText('The level Portfolio was removed.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Ticket types' })).toHaveFocus();
    expect(levelHeadings()[0]).toBe('Initiative');
    expect(
      within(card('Standard')).getByRole('button', { name: 'Manage ticket type Theme' }),
    ).toBeVisible();
  });

  it('[CORE-007] removing a level says a local-mode track’s own types at it fall too', async () => {
    const user = userEvent.setup();
    renderPage({ client: fakeTicketTypesClient({ localType: true }) });
    // No shared type sits at Portfolio, but OPS's own type does.
    const remove = await within(
      await screen.findByRole('region', { name: 'Portfolio' }),
    ).findByRole('button', { name: 'Remove level Portfolio' });
    await expect.poll(() => remove.hasAttribute('disabled')).toBe(false);
    await user.click(remove);
    expect(
      screen.getByRole('group', {
        name: 'Remove Portfolio? 1 ticket type of a track with its own configuration falls to the Standard level. No ticket changes level. This cannot be undone.',
      }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // With a shared type there too, both are said.
    await user.click(screen.getByRole('button', { name: 'New ticket type' }));
    const add = screen.getByRole('form', { name: 'Add a ticket type' });
    await user.type(within(add).getByLabelText('Ticket type name'), 'Theme');
    await user.selectOptions(within(add).getByLabelText('Level'), 'Portfolio');
    await user.click(within(add).getByRole('button', { name: 'Add a ticket type' }));
    await within(card('Portfolio')).findByRole('button', { name: 'Manage ticket type Theme' });
    const again = within(card('Portfolio')).getByRole('button', { name: 'Remove level Portfolio' });
    await expect.poll(() => again.hasAttribute('disabled')).toBe(false);
    await user.click(again);
    expect(
      screen.getByRole('group', {
        name: 'Remove Portfolio? Its type, Theme, falls to the Standard level, as does 1 ticket type of a track with its own configuration. No ticket changes level. This cannot be undone.',
      }),
    ).toBeVisible();
  });

  it('[CORE-005] adds a ticket type with a level and an icon, changes it and deletes it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const opener = await screen.findByRole('button', { name: 'New ticket type' });
    await user.click(opener);
    const add = screen.getByRole('form', { name: 'Add a ticket type' });
    // No colour: what the type draws is its shape, beside its name.
    expect(within(add).getByRole('group', { name: 'Icon' })).toBeVisible();
    expect(within(add).getByLabelText('Plain hexagon')).toBeChecked();
    expect(within(add).getByLabelText('Level')).toHaveDisplayValue('Standard');
    await user.type(within(add).getByLabelText('Ticket type name'), 'Research');
    await user.type(within(add).getByLabelText('Description'), 'Reading before building');
    await user.click(within(add).getByLabelText('Idea'));
    await user.click(within(add).getByRole('button', { name: 'Add a ticket type' }));
    expect(await screen.findByText('Research was added.')).toBeInTheDocument();

    // The new type is open: it goes to Outcome, which moves no ticket, and takes another name.
    const panel = await screen.findByRole('form', { name: 'Settings of Research' });
    await user.selectOptions(within(panel).getByLabelText('Level'), 'Outcome');
    expect(await within(panel).findByText('No ticket of this type changes level.')).toBeVisible();
    const name = within(panel).getByLabelText('Ticket type name');
    await user.clear(name);
    await user.type(name, 'Study');
    await user.click(within(panel).getByRole('button', { name: 'Save the type' }));
    expect(await screen.findByText('Study was saved.')).toBeInTheDocument();
    // It now sits at Outcome, still open there, and its Manage button there has the keyboard.
    const moved = await within(card('Outcome')).findByRole('form', { name: 'Settings of Study' });
    await waitFor(() =>
      expect(
        within(card('Outcome')).getByRole('button', { name: 'Manage ticket type Study' }),
      ).toHaveFocus(),
    );
    await user.click(within(moved).getByRole('button', { name: 'Delete ticket type Study' }));
    const question = within(moved).getByRole('group', {
      name: 'Delete Study? Nothing can use it afterwards, and this cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete ticket type Study' }));
    expect(await screen.findByText('Study was deleted.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Ticket types' })).toHaveFocus();
    expect(writes(client)).toEqual([
      [
        'createType',
        {
          name: 'Research',
          levelId: 2,
          description: 'Reading before building',
          icon: 'idea',
        },
      ],
      ['updateType', 101, { name: 'Study', levelId: 3 }],
      ['deleteType', 101],
    ]);
  });

  it('[CORE-005] keeps the shape a type draws from its name when it is renamed', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage ticket type Bug' }));
    const panel = screen.getByRole('form', { name: 'Settings of Bug' });
    // Bug has no icon of its own and draws the bug by its name.
    expect(within(panel).getByLabelText('Bug')).toBeChecked();
    const name = within(panel).getByLabelText('Ticket type name');
    await user.clear(name);
    await user.type(name, 'Defect');
    await user.click(within(panel).getByRole('button', { name: 'Save the type' }));
    expect(await screen.findByText('Defect was saved.')).toBeInTheDocument();
    // Renamed, it would draw a hexagon: the bug is stored so it stays.
    expect(writes(client)).toEqual([['updateType', 12, { name: 'Defect', icon: 'bug' }]]);
  });

  it('[CORE-007] says what a type’s new level would do, and refuses one that breaks links', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage ticket type Bug' }));
    const panel = screen.getByRole('form', { name: 'Settings of Bug' });
    await user.selectOptions(within(panel).getByLabelText('Level'), 'Outcome');
    expect(
      await within(panel).findByText(
        'This level would be refused: 30 parent links would break, and no ticket would be left without the parent a subticket needs.',
      ),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Save the type' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing changed: 30 parent links would break',
    );
    expect(
      within(card('Standard')).getByRole('button', { name: 'Manage ticket type Bug' }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Manage ticket type Spike' }));
    const spike = screen.getByRole('form', { name: 'Settings of Spike' });
    await user.selectOptions(within(spike).getByLabelText('Level'), 'Subticket');
    expect(
      await within(spike).findByText(
        'This level would be refused: no parent link would break, and 4 tickets would be left without the parent a subticket needs.',
      ),
    ).toBeVisible();
    expect(writes(client)).toEqual([['updateType', 12, { levelId: 3 }]]);
  });

  it('[CORE-005] names the type sets that hold a type, and counts the tickets of one, when it stays', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage ticket type Bug' }));
    await user.click(screen.getByRole('button', { name: 'Delete ticket type Bug' }));
    const question = screen.getByRole('group', { name: /^Delete Bug\?/ });
    await user.click(within(question).getByRole('button', { name: 'Delete ticket type Bug' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Bug is in the type sets Software types: take it out of them on Configuration sets first.',
    );
    // Refused: the question stays open; Cancel gives the focus back (D13).
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete ticket type Bug' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Manage ticket type Spike' }));
    await user.click(screen.getByRole('button', { name: 'Delete ticket type Spike' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Delete Spike\?/ })).getByRole('button', {
        name: 'Delete ticket type Spike',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '4 tickets have this type, the trash included: give them another type first.',
    );
  });

  it('[IAM-009] a configuration administrator may; a member, or someone who only runs tracks, is refused', async () => {
    const client = renderPage({ session: CONFIG_ADMIN });
    expect(await screen.findByRole('button', { name: 'Manage ticket type Bug' })).toBeVisible();
    for (const session of [MEMBER, TRACK_ADMIN]) {
      cleanup();
      const refused = fakeTicketTypesClient();
      renderPage({ session, client: refused });
      expect(
        screen.getByText(
          'Only site and configuration administrators manage ticket types and levels.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'New ticket type' })).toBeNull();
      expect(document.querySelector('.page-purpose')).toBeNull();
      expect(refused.calls).toEqual([]);
    }
    expect(client.calls).toEqual([]);
  });

  it('[NFR-005] fits a small phone, in Spanish too', async () => {
    setViewportWidth(375);
    renderPage({ locale: 'es' });
    expect(
      await screen.findByRole('button', { name: 'Gestionar el tipo de ticket Bug' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Nuevo tipo de ticket' })).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderPage({ locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const manage = within(main).getAllByRole('button', { expanded: false });
    await user.click(
      manage.find((b) => b.getAttribute('aria-label')?.includes('Bug')) as HTMLElement,
    );
    const data = new Set([
      'Portfolio',
      'Initiative',
      'Several outcomes that move one goal',
      'Outcome',
      'A result that several tickets deliver together',
      'Standard',
      'Subticket',
      'Feature',
      'Bug',
      'Something that does not work as it should',
      'Chore',
      'Spike',
      'A short study',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { AreasPage } from './AreasPage';
import { AREAS, CHECKOUT, fakeAreaClient, LEGACY, SEARCH, SHOP } from './fixtures';

function renderPage(client = fakeAreaClient(), locale: Locale = 'en') {
  render(
    <I18nProvider locale={locale}>
      <main>
        <AreasPage client={client} trackKey="SHOP" />
      </main>
    </I18nProvider>,
  );
  return client;
}

/** An area's row, by its name. */
const rowOf = (name: string) =>
  screen.getByText(name, { selector: '.people-name' }).closest('li') as HTMLElement;

describe('a track’s areas (CORE-015)', () => {
  it('[CORE-015] opens at its address under the track’s tab bar, with no tab of its own', async () => {
    const calls = stubBackend({
      'GET /tracks/SHOP': () =>
        jsonResponse(200, {
          track: { ...SHOP, sections: { backlog: false, sprints: false } },
        }),
      'GET /tracks/1/areas?archived=include': () => jsonResponse(200, { areas: AREAS }),
      'GET /tracks/1/releases?archived=only': () =>
        jsonResponse(200, { releases: [], mayManage: false }),
    });
    window.location.hash = '#/tracks/SHOP/areas';
    render(<App session={MEMBER} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Areas' })).toBeVisible();
    const bar = await screen.findByRole('navigation', { name: 'Sections of SHOP' });
    expect(bar.querySelector('[aria-current]')).toBeNull();
    expect(await screen.findByText('Owner: Sam Rivera')).toBeVisible();
    // Read by a member: what they may do comes from the releases list, the same rule.
    expect(
      screen.getByText('Only the administrators of this track can change its areas.'),
    ).toBeVisible();
    expect(calls.map((c) => c.path)).toContain('/tracks/1/releases?archived=only');
  });

  it('[CORE-015] lists each area with its owner, its team and its rule, the archived ones apart', async () => {
    renderPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Areas' });
    // Titled like the track's other pages, the track named above the title (D26).
    const header = heading.closest('header') as HTMLElement;
    expect(within(header).getByText('Shop')).toBeVisible();
    expect(
      within(header).getByText(
        'The parts of this track’s work, who owns each, and who gets its new tickets.',
      ),
    ).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Areas of SHOP' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const checkout = rowOf('Checkout');
    expect(
      within(checkout).getByText('Paying for an order, from the cart to the receipt'),
    ).toBeVisible();
    expect(within(checkout).getByText('Owner: Sam Rivera')).toBeVisible();
    expect(within(checkout).getByText('Owner team: Payments')).toBeVisible();
    expect(
      within(checkout).getByText('New tickets with no assignee go to the area owner.'),
    ).toBeVisible();
    const search = rowOf('Search');
    expect(within(search).getByText('No owner')).toBeVisible();
    expect(
      within(search).getByText('New tickets with no assignee go to the track owner.'),
    ).toBeVisible();
    // Archived areas stay on their tickets and are listed apart.
    const archived = screen.getByRole('region', { name: 'Archived areas' });
    expect(within(archived).getByText('Legacy app')).toBeVisible();
    expect(within(archived).getByRole('button', { name: 'Restore area Legacy app' })).toBeVisible();
    expect(within(list).queryByText('Legacy app')).toBeNull();
  });

  it('[CORE-015] someone who may not change them reads them, with no way to', async () => {
    renderPage(fakeAreaClient(AREAS, { mayManage: false }));
    expect(
      await screen.findByText('Only the administrators of this track can change its areas.'),
    ).toBeVisible();
    expect(screen.getByText('Owner: Sam Rivera')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New area' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /^(Change|Archive|Delete|Restore) area/ }),
    ).toBeNull();
  });

  it('[CORE-015] says an archived track’s areas cannot change', async () => {
    renderPage(fakeAreaClient(AREAS, { track: { ...SHOP, archived: true } }));
    expect(
      await screen.findByText('This track is archived, so its areas cannot change.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New area' })).toBeNull();
  });

  it('[CORE-015] explains a track with no areas yet', async () => {
    renderPage(fakeAreaClient([]));
    expect(await screen.findByText('No areas yet')).toBeVisible();
    expect(screen.getByText(/Once the track has some, the create form offers them/)).toBeVisible();
  });

  it('[CORE-015] (1) adds an area with its owner, its team and its rule', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New area' }));
    const form = screen.getByRole('form', { name: 'New area' });
    // The form's first field takes the focus.
    expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(within(form).getByRole('button', { name: 'Save the area' })).toBeDisabled();
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Billing');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Invoices');
    await user.type(within(form).getByRole('searchbox', { name: 'Owner' }), 'ana');
    await user.click(await within(form).findByRole('button', { name: 'Ana Duarte' }));
    await user.type(within(form).getByRole('searchbox', { name: 'Owner team' }), 'plat');
    await user.click(await within(form).findByRole('button', { name: 'Platform' }));
    const rule = within(form).getByRole('combobox', { name: 'New tickets with no assignee go to' });
    expect(rule).toHaveValue('unassigned');
    await user.selectOptions(rule, 'The area owner');
    await user.click(within(form).getByRole('button', { name: 'Save the area' }));
    expect(await screen.findByText('Area Billing was added.')).toBeInTheDocument();
    expect(client.created).toEqual([
      {
        name: 'Billing',
        description: 'Invoices',
        ownerId: 22,
        ownerTeamId: 6,
        defaultAssignee: 'area_owner',
      },
    ]);
    expect(screen.queryByRole('form', { name: 'New area' })).toBeNull();
    const billing = rowOf('Billing');
    expect(within(billing).getByText('Owner: Ana Duarte')).toBeVisible();
    expect(within(billing).getByText('Owner team: Platform')).toBeVisible();
    // The form closed with the focus in it: the New button has it back (D11).
    expect(screen.getByRole('button', { name: 'New area' })).toHaveFocus();
  });

  it('[CORE-015] says when the rule names an owner the area does not have', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New area' }));
    const form = screen.getByRole('form', { name: 'New area' });
    const rule = within(form).getByRole('combobox', { name: 'New tickets with no assignee go to' });
    await user.selectOptions(rule, 'The area owner');
    expect(rule).toHaveAccessibleDescription(
      'This area has no owner yet: until it has one, its rule gives new tickets to nobody.',
    );
  });

  it('[CORE-015] says why a name or one more area is refused, and keeps the form', async () => {
    const user = userEvent.setup();
    renderPage(fakeAreaClient(AREAS, { limit: 2 }));
    await user.click(await screen.findByRole('button', { name: 'New area' }));
    const form = screen.getByRole('form', { name: 'New area' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'checkout');
    await user.click(within(form).getByRole('button', { name: 'Save the area' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'This track already has an area with that name.',
    );
    await user.clear(name);
    await user.type(name, 'Mobile');
    await user.click(within(form).getByRole('button', { name: 'Save the area' }));
    await waitFor(() =>
      expect(within(form).getByRole('alert')).toHaveTextContent(
        'This track has as many areas as the site allows (2). Archive one first, or ask a site administrator to raise the limit under Guardrails.',
      ),
    );
    expect(name).toHaveValue('Mobile');
  });

  it('[CORE-015] changes an area, its Change button keeping the focus', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Change area Checkout' }));
    const form = screen.getByRole('form', { name: 'Change area Checkout' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveFocus();
    expect(within(form).getByText('Sam Rivera')).toBeVisible();
    // Cancel goes back to the row's Change.
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Change area Checkout' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Change area Checkout' }));
    const again = screen.getByRole('form', { name: 'Change area Checkout' });
    await user.clear(within(again).getByRole('textbox', { name: 'Name' }));
    await user.type(within(again).getByRole('textbox', { name: 'Name' }), 'Payments flow');
    await user.click(within(again).getByRole('button', { name: 'Remove Sam Rivera as owner' }));
    await user.selectOptions(
      within(again).getByRole('combobox', { name: 'New tickets with no assignee go to' }),
      'The track owner',
    );
    await user.click(within(again).getByRole('button', { name: 'Save the area' }));
    expect(await screen.findByText('Area Payments flow was saved.')).toBeInTheDocument();
    expect(client.updated).toEqual([
      {
        id: CHECKOUT.id,
        input: {
          name: 'Payments flow',
          description: CHECKOUT.description,
          ownerId: null,
          ownerTeamId: 5,
          defaultAssignee: 'track_owner',
        },
      },
    ]);
    expect(within(rowOf('Payments flow')).getByText('No owner')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change area Payments flow' })).toHaveFocus(),
    );
  });

  it('[CORE-015] (2) archives and restores an area, the focus following its row', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Archive area Search' }));
    expect(await screen.findByText('Area Search was archived.')).toBeInTheDocument();
    const archived = screen.getByRole('region', { name: 'Archived areas' });
    const restore = await within(archived).findByRole('button', { name: 'Restore area Search' });
    await waitFor(() => expect(restore).toHaveFocus());
    // An archived area cannot be changed until it is restored.
    expect(within(archived).queryByRole('button', { name: 'Change area Search' })).toBeNull();
    await user.click(restore);
    expect(await screen.findByText('Area Search was restored.')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Areas of SHOP' });
    const archive = await within(list).findByRole('button', { name: 'Archive area Search' });
    await waitFor(() => expect(archive).toHaveFocus());
    expect(client.archived).toEqual([SEARCH.id]);
    expect(client.restored).toEqual([SEARCH.id]);
  });

  it('[CORE-015] deletes an area no ticket is in only after asking', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const trigger = await screen.findByRole('button', { name: 'Delete area Search' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    expect(client.removed).toEqual([]);
    // Asks first, saying what will happen (D13); Escape gives the focus back.
    const question = screen.getByRole('group', {
      name: 'Delete area Search? It cannot be brought back. If tickets are in it, you choose where they go next.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Delete area Search' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete area Search' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete area Search' }),
    );
    expect(await screen.findByText('Area Search was deleted.')).toBeInTheDocument();
    expect(client.removed).toEqual([{ id: SEARCH.id }]);
    await waitFor(() =>
      expect(screen.queryByText('Search', { selector: '.people-name' })).toBeNull(),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('[CORE-015] asks where an area’s tickets go before deleting it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete area Checkout' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete area Checkout' }),
    );
    // The server says how many tickets are in it (409 in_use): the row asks where they go.
    const form = await screen.findByRole('form', { name: 'Where tickets in Checkout go' });
    expect(within(form).getByText(/3 tickets are in Checkout\./)).toBeVisible();
    expect(within(form).getByRole('link', { name: 'Open them in search' })).toHaveAttribute(
      'href',
      `#/search?${new URLSearchParams({ q: 'track = SHOP AND area = "Checkout"' })}`,
    );
    const to = within(form).getByRole('combobox', { name: 'Move them to' });
    expect(to).toHaveFocus();
    // Only the track's other areas that are not archived take the tickets.
    expect(
      within(to)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['No area: take Checkout off them', 'Search']);
    // Cancel goes back to the row's own Delete.
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete area Checkout' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete area Checkout' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete area Checkout' }),
    );
    const again = await screen.findByRole('form', { name: 'Where tickets in Checkout go' });
    await user.selectOptions(
      within(again).getByRole('combobox', { name: 'Move them to' }),
      'Search',
    );
    await user.click(within(again).getByRole('button', { name: 'Delete area Checkout' }));
    expect(
      await screen.findByText('Area Checkout was deleted; its tickets moved to Search.'),
    ).toBeInTheDocument();
    expect(client.removed).toEqual([{ id: CHECKOUT.id, deletion: { replacementId: SEARCH.id } }]);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('[CORE-015] takes an area off its tickets when no other area takes them', async () => {
    const user = userEvent.setup();
    const client = renderPage(fakeAreaClient([CHECKOUT, LEGACY]));
    await user.click(await screen.findByRole('button', { name: 'Delete area Checkout' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete area Checkout' }),
    );
    const form = await screen.findByRole('form', { name: 'Where tickets in Checkout go' });
    // An archived area takes no tickets: only "No area" is left.
    expect(
      within(form)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['No area: take Checkout off them']);
    await user.click(within(form).getByRole('button', { name: 'Delete area Checkout' }));
    expect(
      await screen.findByText('Area Checkout was deleted and taken off its tickets.'),
    ).toBeInTheDocument();
    expect(client.removed).toEqual([{ id: CHECKOUT.id, deletion: { removeFromTickets: true } }]);
  });

  it('[CORE-015] says when the area chosen for the tickets can no longer take them, and keeps the choice open', async () => {
    const user = userEvent.setup();
    const client = fakeAreaClient();
    const remove = client.remove;
    client.remove = async (areaId, deletion) => {
      if (deletion && 'replacementId' in deletion) {
        throw new ApiError(400, { error: 'invalid_request', detail: 'replacementId' });
      }
      return remove(areaId, deletion);
    };
    renderPage(client);
    await user.click(await screen.findByRole('button', { name: 'Delete area Checkout' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete area Checkout' }),
    );
    const form = await screen.findByRole('form', { name: 'Where tickets in Checkout go' });
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Move them to' }),
      'Search',
    );
    await user.click(within(form).getByRole('button', { name: 'Delete area Checkout' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That area can no longer take the tickets. Choose another.',
    );
    expect(screen.getByRole('form', { name: 'Where tickets in Checkout go' })).toBeVisible();
    expect(client.removed).toEqual([]);
  });

  it('[CORE-015] keeps the question open on a refusal, saying why', async () => {
    const user = userEvent.setup();
    const client = fakeAreaClient();
    client.remove = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    renderPage(client);
    await user.click(await screen.findByRole('button', { name: 'Delete area Search' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete area Search' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the administrators of this track can change its areas.',
    );
    expect(screen.getByRole('group', { name: /^Delete area Search\?/ })).toBeVisible();
  });

  it('[CORE-015] says when the areas cannot be read, under the page’s title', async () => {
    const client = fakeAreaClient();
    client.list = async () => {
      throw new Error('gone');
    };
    renderPage(client);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The areas could not be loaded. Try again in a moment.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Areas' })).toBeVisible();
  });

  it('[CORE-015] fits a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New area' }));
    expect(screen.getByRole('form', { name: 'New area' })).toBeVisible();
  });

  it('[CORE-015] [NFR-006] asks in Spanish', async () => {
    renderPage(fakeAreaClient(), 'es');
    expect(await screen.findByRole('heading', { level: 1, name: 'Áreas' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Área nueva' })).toBeVisible();
    expect(screen.getByText('Propietario: Sam Rivera')).toBeVisible();
  });

  it('[CORE-015] passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderPage(fakeAreaClient(), 'en-XA');
    const main = screen.getByRole('main');
    const edit = await waitFor(() => {
      const found = main.querySelector<HTMLElement>('.people-action');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await user.click(edit);
    const data = [
      'Shop',
      'Checkout',
      'Search',
      'Legacy app',
      'Paying for an order, from the cart to the receipt',
      'Sam Rivera',
      'Payments',
    ];
    const texts = visibleTexts(main).filter(
      (t) => !data.includes(t) && !data.some((d) => t === `[${d}]`),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

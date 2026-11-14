import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { ESTIMATES, type FakeGridOptions, fakeGridClient } from './grid/clientFixtures';
import { MoveUnderDialog, moveRefusal } from './MoveUnderDialog';
import { PlanGridPage } from './PlanGridPage';

/**
 * Moving a row of a plan's Grid (T-089a; PLN-010 acceptance 2; ADR-122 stage 10): one row with
 * everything below it, under another parent, only after confirmation and through the ticket's own
 * change; a refusal says why and nothing moves. The sample: SHOP-1 and SHOP-2 are Outcomes,
 * SHOP-41, SHOP-44, SHOP-50 and SHOP-70 standard tickets, SHOP-60 a closed subticket of SHOP-41,
 * OPS-12 a closed ticket of another track and DATA-7 placed by a link.
 */
const saved = { structures: [{ id: 3, name: 'Estimates', spec: ESTIMATES }] };

function renderGrid(options: FakeGridOptions = {}) {
  const grid = fakeGridClient({ ...saved, ...options });
  const result = render(
    <I18nProvider locale="en">
      <PlanGridPage
        planId={12}
        view={{ filters: {}, group: null }}
        scenario={null}
        client={grid}
        search={grid.search}
      />
    </I18nProvider>,
  );
  return { grid, ...result };
}

const rowOf = (key: string) =>
  screen.getByRole('rowheader', { name: new RegExp(`(^|\\s)${key}(?!\\d)`) })
    .parentElement as HTMLElement;
const cellsOf = (key: string) =>
  Array.from(rowOf(key).querySelectorAll('td')).map((c) => c.textContent);

/** Opens a row's menu by its grip and chooses one of its moves. */
async function choose(user: ReturnType<typeof userEvent.setup>, key: string, move: RegExp) {
  await user.click(screen.getByRole('button', { name: `Move ${key}` }));
  await user.click(await screen.findByRole('menuitem', { name: move }));
  return screen.findByRole('dialog');
}

/** A drag by a row's grip with a mouse, let go over `over`'s tree cell (T-162's pattern). */
function dragOnto(grip: Element, over: Element | null) {
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(over);
  const point = { pointerId: 8, pointerType: 'mouse', isPrimary: true };
  const fire = (
    kind: 'pointerDown' | 'pointerMove' | 'pointerUp',
    target: Element | Window,
    init: object,
    time: number,
  ) => {
    const event = createEvent[kind](target, init);
    Object.defineProperty(event, 'timeStamp', { value: time });
    fireEvent(target, event);
  };
  fire('pointerDown', grip, { ...point, button: 0, clientX: 10, clientY: 200 }, 1_000);
  fire('pointerMove', window, { ...point, buttons: 1, clientX: 40, clientY: 300 }, 1_016);
  fire('pointerMove', window, { ...point, buttons: 1, clientX: 80, clientY: 320 }, 1_032);
  const ghost = document.querySelector('.drag-ghost')?.textContent ?? null;
  fire('pointerUp', window, { ...point, clientX: 80, clientY: 320 }, 1_048);
  under.mockRestore();
  return ghost;
}

afterEach(() => {
  window.localStorage.clear();
  act(() => setViewportWidth(1440));
});

describe('moving a row of the Grid (PLN-010)', () => {
  it('[PLN-010] moves a row under another parent only after confirmation, and its totals follow', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid();
    await screen.findByRole('treegrid');
    await screen.findByText('Dark mode for receipts');
    // SHOP-2's estimate: SHOP-50's total of 4 h (its link-placed DATA-7).
    expect(cellsOf('SHOP-2')).toContain('4 h');
    const dialog = await choose(user, 'SHOP-70', /^Move under/);
    expect(within(dialog).getByRole('heading', { name: 'Move SHOP-70 under…' })).toBeVisible();
    // Unsearched, only the rows that can be its parent: the two Outcomes.
    const offered = within(dialog)
      .getAllByRole('radio')
      .map((r) => r.closest('li')?.querySelector('.plan-grid-move-key')?.textContent);
    expect(offered).toEqual(['SHOP-1', 'SHOP-2']);
    await user.click(within(dialog).getByRole('radio', { name: /^SHOP-2/ }));
    expect(within(dialog).getByText('Move SHOP-70 under SHOP-2?')).toBeVisible();
    expect(
      within(dialog).getByText('It has no parent now; SHOP-2 becomes its parent.'),
    ).toBeVisible();
    // Nothing is sent until Move.
    expect(grid.calls.moves).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(grid.calls.moves).toEqual([{ id: 70, parent: 2, version: 1 }]);
    expect(screen.getByText('SHOP-70 moved under SHOP-2.')).toBeVisible();
    // The row moved under its new parent at once, and the totals above it changed.
    await waitFor(() => expect(rowOf('SHOP-70')).toHaveAttribute('aria-level', '2'));
    expect(cellsOf('SHOP-2')).toContain('6 h');
    // The skeleton read again behind agrees, and keeps the row there.
    await waitFor(() => expect(grid.calls.rows.length).toBe(2));
    await waitFor(() => expect(rowOf('SHOP-70')).toHaveFocus());
    expect(rowOf('SHOP-70')).toHaveAttribute('aria-level', '2');
    // Only that read keeps the moved row in focus: Refresh starts again at the first row.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(grid.calls.rows.length).toBe(3));
    await waitFor(() => expect(rowOf('SHOP-1')).toHaveAttribute('tabindex', '0'));
    expect(rowOf('SHOP-70')).toHaveAttribute('tabindex', '-1');
  });

  it('[PLN-010] says why a row cannot be the parent: its level, its track, its own rows', async () => {
    const user = userEvent.setup();
    renderGrid();
    await screen.findByText('Retry the refund job');
    const dialog = await choose(user, 'SHOP-60', /^Move under/);
    // A subticket: its parent one level up, in its own track.
    const find = within(dialog).getByRole('searchbox', { name: /^Find the new parent/ });
    await user.type(find, 'OPS');
    const ops = within(dialog).getByRole('radio', { name: /^OPS-12/ });
    expect(ops).toBeDisabled();
    expect(ops).toHaveAccessibleDescription('A subticket stays in its parent’s track.');
    await user.clear(find);
    await user.type(find, 'SHOP-1');
    expect(within(dialog).getByRole('radio', { name: /^SHOP-1 / })).toHaveAccessibleDescription(
      'Its parent must be a ticket of the Standard level.',
    );
    // Its parent now.
    await user.clear(find);
    await user.type(find, 'SHOP-41');
    expect(within(dialog).getByRole('radio', { name: /^SHOP-41/ })).toHaveAccessibleDescription(
      'This is already its parent.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // An Outcome's own rows are never its parent.
    const outcome = await choose(user, 'SHOP-41', /^Move under/);
    await user.type(within(outcome).getByRole('searchbox'), 'zzz');
    expect(within(outcome).getByText('No row to choose')).toBeVisible();
  });

  it('[PLN-010] a refusal of the ticket route says why, and nothing moves', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid({ locked: [70] });
    await screen.findByText('Retry the refund job');
    // SHOP-60 is closed: the fake route refuses the change as `forbidden`.
    let dialog = await choose(user, 'SHOP-60', /^Move under/);
    await user.click(within(dialog).getByRole('radio', { name: /^SHOP-44/ }));
    expect(within(dialog).getByText('Its parent changes from SHOP-41 to SHOP-44.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You may not change this ticket.',
    );
    expect(rowOf('SHOP-60')).toHaveAttribute('aria-level', '3');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // A status's lock.
    dialog = await choose(user, 'SHOP-70', /^Move under/);
    await user.click(within(dialog).getByRole('radio', { name: /^SHOP-1/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Tickets in this status cannot be changed.',
    );
    expect(rowOf('SHOP-70')).toHaveAttribute('aria-level', '1');
    expect(grid.calls.moves).toHaveLength(2);
    expect(grid.calls.rows).toHaveLength(1);
  });

  it('[PLN-010] a ticket changed meanwhile is refused (409), read again, and moved on the next try', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid();
    await screen.findByText('Dark mode for receipts');
    const dialog = await choose(user, 'SHOP-70', /^Move under/);
    // Someone else changes SHOP-70 while the dialog is open.
    const held = grid.store.get(70);
    if (held) grid.store.set(70, { ...held, version: 4 });
    await user.click(within(dialog).getByRole('radio', { name: /^SHOP-1/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /^Someone changed this ticket since the grid read it, so nothing moved/,
    );
    expect(rowOf('SHOP-70')).toHaveAttribute('aria-level', '1');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(grid.calls.moves.map((m) => m.version)).toEqual([1, 4]);
    await waitFor(() => expect(rowOf('SHOP-70')).toHaveAttribute('aria-level', '2'));
  });

  it('[PLN-010] removes a row from its parent after confirming; a subticket keeps one', async () => {
    const user = userEvent.setup();
    const { grid } = renderGrid();
    await screen.findByText('Refunds fail for expired cards');
    const dialog = await choose(user, 'SHOP-41', /^Remove from parent/);
    expect(
      within(dialog).getByRole('heading', { name: 'Remove SHOP-41 from its parent' }),
    ).toBeVisible();
    expect(within(dialog).getByText('Its parent changes from SHOP-1 to none.')).toBeVisible();
    expect(within(dialog).getByText('1 row moves with it.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Remove from parent' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(grid.calls.moves).toEqual([{ id: 41, parent: null, version: 1 }]);
    await waitFor(() => expect(rowOf('SHOP-41')).toHaveAttribute('aria-level', '1'));
    expect(rowOf('SHOP-60')).toHaveAttribute('aria-level', '2');
    // A subticket needs a parent: said before anything is sent.
    const sub = await choose(user, 'SHOP-60', /^Remove from parent/);
    expect(within(sub).getByText('A subticket needs a parent.')).toBeVisible();
    await user.click(within(sub).getByRole('button', { name: 'Remove from parent' }));
    expect(grid.calls.moves).toHaveLength(1);
  });

  it('[PLN-010] [QRY-008] never names a parent the viewer may not see', async () => {
    const user = userEvent.setup();
    renderGrid({ hiddenParents: [70] });
    await screen.findByText('Dark mode for receipts');
    const dialog = await choose(user, 'SHOP-70', /^Move under/);
    await user.click(within(dialog).getByRole('radio', { name: /^SHOP-1/ }));
    expect(
      within(dialog).getByText('Its parent changes from a ticket you may not see to SHOP-1.'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const remove = await choose(user, 'SHOP-70', /^Remove from parent/);
    expect(
      within(remove).getByText('Its parent changes from a ticket you may not see to none.'),
    ).toBeVisible();
  });

  it('[PLN-010] opens a row’s menu with Shift and F10; a row placed by a link says why it has none', async () => {
    const user = userEvent.setup();
    renderGrid();
    await screen.findByText('Dark mode for receipts');
    act(() => rowOf('SHOP-70').focus());
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(await screen.findByRole('menuitem', { name: 'Move under…' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Move SHOP-70 under…' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // DATA-7's place comes from a link: no grip, and its menu key says why.
    expect(screen.queryByRole('button', { name: 'Move DATA-7' })).toBeNull();
    act(() => rowOf('DATA-7').focus());
    await user.keyboard('{ContextMenu}');
    expect(
      screen.getByText('DATA-7 is placed by a link, not its parent, so it cannot move here.'),
    ).toBeVisible();
  });

  it('[PLN-010] drags a row onto its new parent and asks first; a drop elsewhere says why', async () => {
    const { grid } = renderGrid();
    await screen.findByText('Dark mode for receipts');
    const grip = () => screen.getByRole('button', { name: 'Move SHOP-70' });
    // Onto a row of its own level: refused in words, nothing asked or sent.
    const refusedGhost = dragOnto(grip(), within(rowOf('SHOP-44')).getByRole('rowheader'));
    expect(refusedGhost).toBe('Its parent must be a ticket of the Outcome level.');
    expect(
      screen.getByText('SHOP-70 was not moved: Its parent must be a ticket of the Outcome level.'),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Onto an Outcome: the confirmation, with the target chosen.
    const ghost = dragOnto(grip(), within(rowOf('SHOP-1')).getByRole('rowheader'));
    expect(ghost).toBe('Move SHOP-70 under SHOP-1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move SHOP-70 under SHOP-1?')).toBeVisible();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(grid.calls.moves).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(grid.calls.moves).toEqual([{ id: 70, parent: 1, version: 1 }]));
    await waitFor(() => expect(rowOf('SHOP-70')).toHaveAttribute('aria-level', '2'));
  });

  it('[PLN-010] a scenario’s grid moves nothing: no grips, no menu', async () => {
    const grid = fakeGridClient(saved);
    render(
      <I18nProvider locale="en">
        <PlanGridPage
          planId={12}
          view={{ filters: {}, group: null, scenario: 4 }}
          scenario={{ id: 4, name: 'Faster' }}
          client={grid}
          search={grid.search}
        />
      </I18nProvider>,
    );
    await screen.findByRole('treegrid');
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });

  it('[PLN-010] on a phone, a card’s sheet offers Move under', async () => {
    act(() => setViewportWidth(360));
    const user = userEvent.setup();
    const { grid } = renderGrid();
    const cards = await screen.findByRole('list', { name: '9 rows' });
    await user.click(within(cards).getByRole('button', { name: /^Open SHOP-44(?!\d)/ }));
    const sheet = await screen.findByRole('dialog', { name: /^SHOP-44/ });
    await user.click(within(sheet).getByRole('button', { name: 'Move under…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move SHOP-44 under…' });
    await user.click(within(dialog).getByRole('radio', { name: /^SHOP-2/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(grid.calls.moves).toEqual([{ id: 44, parent: 2, version: 1 }]));
    expect(await screen.findByText('SHOP-44 moved under SHOP-2.')).toBeVisible();
  });
});

describe('the Move under dialog (PLN-010)', () => {
  it('[PLN-010] asks before it moves, and says the server’s refusal', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn(async () => 'A ticket of this type cannot sit under that ticket.');
    render(
      <I18nProvider locale="en">
        <MoveUnderDialog
          moving="ABC-12"
          from={{ key: 'GHI-1' }}
          below={6}
          target={{ row: 4, key: 'DEF-3' }}
          onMove={onMove}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Move ABC-12 under DEF-3?')).toBeVisible();
    expect(within(dialog).getByText('Its parent changes from GHI-1 to DEF-3.')).toBeVisible();
    expect(within(dialog).getByText('6 rows move with it.')).toBeVisible();
    expect(onMove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledWith(4);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'A ticket of this type cannot sit under that ticket.',
    );
  });

  it('[PLN-010] puts each refusal of the ticket route in words', () => {
    const refused = (status: number, body: object) => moveRefusal(new ApiError(status, body)).id;
    expect(refused(400, { error: 'invalid_fields', fields: { parent: 'wrong_level' } })).toBe(
      'grid.move.no.level',
    );
    expect(refused(400, { error: 'invalid_fields', fields: { parent: 'other_track' } })).toBe(
      'grid.move.no.track',
    );
    expect(refused(400, { error: 'invalid_fields', fields: { parent: 'required' } })).toBe(
      'grid.move.no.required',
    );
    expect(refused(400, { error: 'invalid_fields', fields: { parent: 'not_found' } })).toBe(
      'grid.move.refused.parentGone',
    );
    expect(refused(403, { error: 'forbidden', permission: 'edit_tickets' })).toBe(
      'grid.move.refused.forbidden',
    );
    expect(moveRefusal(new ApiError(409, { error: 'version_conflict' }))).toEqual({
      id: 'grid.move.refused.stale',
      stale: true,
    });
    expect(refused(409, { error: 'track_archived' })).toBe('grid.move.refused.archived');
    expect(moveRefusal(new Error('offline')).id).toBe('grid.move.refused.other');
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    const view = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <MoveUnderDialog
          moving="ABC-12"
          from="hidden"
          below={1}
          candidates={() => ({
            list: [
              { row: 1, key: 'DEF-3', summary: null, level: 'Outcome', problem: null },
              { row: 2, key: 'DEF-4', summary: null, level: 'Outcome', problem: 'No' },
            ],
            more: 3,
          })}
          onMove={async () => null}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    await user.click(screen.getByRole('radio', { name: /DEF-3/ }));
    const body = view.baseElement;
    const data = new Set(['Outcome', 'No']);
    const typed = (x: string) => data.has(x) || /^[A-Z]+-\d+$/.test(x);
    expect(untranslated(visibleTexts(body).filter((x) => !typed(x)))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

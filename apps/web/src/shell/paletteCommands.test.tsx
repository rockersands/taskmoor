import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Command, CommandPalette } from './CommandPalette';
import {
  PaletteCommandsProvider,
  usePaletteCommands,
  useRegisteredCommands,
} from './paletteCommands';

const TICKET: Command[] = [
  {
    id: 'ticket-follow',
    labelId: 'palette.ticket.follow',
    values: { key: 'SHOP-41' },
    run: () => {},
  },
];

function TicketView() {
  usePaletteCommands('ticket-view', TICKET);
  return null;
}

function Harness() {
  const [showing, setShowing] = useState(true);
  const registered = useRegisteredCommands();
  return (
    <>
      <button type="button" onClick={() => setShowing(false)}>
        Leave
      </button>
      {showing && <TicketView />}
      <CommandPalette
        commands={[{ id: 'go-home', labelId: 'nav.home', run: () => {} }, ...registered]}
      />
    </>
  );
}

describe('commands pages add to the palette (M1-052)', () => {
  it('[AGL-018] shows a page’s commands while it is mounted, and only then', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <PaletteCommandsProvider>
          <Harness />
        </PaletteCommandsProvider>
      </I18nProvider>,
    );
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('option', { name: 'Follow SHOP-41' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.keyboard('{Escape}');
    await act(async () => {
      screen.getByRole('button', { name: 'Leave' }).click();
    });
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('option', { name: 'Follow SHOP-41' })).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});

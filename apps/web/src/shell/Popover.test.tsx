import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { Popover } from './Popover';

function renderPopover(on = false) {
  render(
    <I18nProvider locale="en">
      <p>Outside text</p>
      <input aria-label="Another field" />
      <Popover label="People" title="People on this board" on={on}>
        <input type="checkbox" aria-label="Rin" />
      </Popover>
      <button type="button">After</button>
    </I18nProvider>,
  );
}

const opener = () => screen.getByRole('button', { name: 'People' });
const panel = () => screen.queryByRole('group', { name: 'People on this board' });

describe('a popover (ADR-114)', () => {
  it('[AGL-005] opens from its button, in the page order, and says it is open', async () => {
    const user = userEvent.setup();
    renderPopover();
    expect(opener()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();
    opener().focus();
    await user.keyboard('{Enter}');
    expect(opener()).toHaveAttribute('aria-expanded', 'true');
    expect(opener()).toHaveAttribute('aria-controls', panel()?.id);
    // Tab goes from the button into the panel.
    await user.tab();
    await user.tab();
    expect(screen.getByRole('checkbox', { name: 'Rin' })).toHaveFocus();
  });

  it('[AGL-005] closes on Escape and gives focus back to its button', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(opener());
    screen.getByRole('checkbox', { name: 'Rin' }).focus();
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();
    expect(opener()).toHaveFocus();
  });

  it('[AGL-005] closes on a click outside and gives focus back to its button', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(opener());
    await user.click(screen.getByText('Outside text'));
    expect(panel()).toBeNull();
    expect(opener()).toHaveFocus();
  });

  it('[AGL-005] leaves focus on a field the click landed on', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(opener());
    await user.click(screen.getByRole('textbox', { name: 'Another field' }));
    expect(panel()).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Another field' })).toHaveFocus();
  });

  it('[AGL-005] stays open for a click inside, and closes when focus moves on', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(opener());
    await user.click(screen.getByRole('checkbox', { name: 'Rin' }));
    expect(panel()).not.toBeNull();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(panel()).toBeNull();
  });

  it('[AGL-005] has a Done button, shown on a phone, that closes it', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.click(opener());
    await user.click(screen.getByText('Done'));
    expect(panel()).toBeNull();
    expect(opener()).toHaveFocus();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { ModalDialog } from './ModalDialog';
import { leaveMotion, playMotion } from './motion';
import { Popover } from './Popover';

/** A browser where motion is welcome and surfaces have a size; jsdom has neither. */
function allowMotion() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) => ({ matches: query.includes('no-preference') }) as MediaQueryList,
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 20, 300, 200),
  );
}

const melting = () => document.querySelector<HTMLElement>('.motion-collapse');

afterEach(() => {
  // Before the shared cleanup unmounts anything, so that makes no more copies.
  vi.restoreAllMocks();
  for (const copy of document.querySelectorAll('.motion-collapse, .motion-fade-out')) copy.remove();
});

function Dialog() {
  const [open, setOpen] = useState(true);
  return open ? (
    <ModalDialog onClose={() => setOpen(false)} labelledBy="title" closeLabel="Close">
      <h2 id="title">Name of the dialog</h2>
    </ModalDialog>
  ) : null;
}

describe('a surface melts as it leaves (ADR-114)', () => {
  it('[NFR-005] is gone at once, leaving an empty copy that nothing can reach', async () => {
    allowMotion();
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <Popover label="Filters" title="Board filters">
          <p>What is inside</p>
        </Popover>
      </I18nProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('group', { name: 'Board filters' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Board filters' })).toBeNull();
    expect(screen.queryByText('What is inside')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveFocus();

    const copy = melting();
    expect(copy).toHaveAttribute('aria-hidden', 'true');
    expect(copy).toHaveClass('popover');
    expect(copy).toBeEmptyDOMElement();
    expect(copy?.style.getPropertyValue('position')).toBe('fixed');
    expect(copy?.style.getPropertyValue('pointer-events')).toBe('none');
    if (copy) fireEvent.animationEnd(copy);
    expect(melting()).toBeNull();
  });

  it('[NFR-005] takes its backdrop along, as a fade', async () => {
    allowMotion();
    const user = userEvent.setup();
    render(<Dialog />);
    expect(screen.getByRole('dialog', { name: 'Name of the dialog' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(melting()).toHaveClass('create-dialog');
    expect(document.querySelector('.motion-fade-out')).toHaveClass('shell-backdrop');
  });

  it('[NFR-005] removes the copy even when its animation never ends', async () => {
    allowMotion();
    vi.useFakeTimers();
    try {
      const { unmount } = render(<div ref={leaveMotion} className="palette" />);
      unmount();
      await Promise.resolve();
      expect(melting()).not.toBeNull();
      vi.advanceTimersByTime(500);
      expect(melting()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[NFR-005] makes no copy when the person asked for less motion', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(10, 20, 300, 200),
    );
    const { unmount } = render(<div ref={leaveMotion} className="palette" />);
    unmount();
    await Promise.resolve();
    expect(melting()).toBeNull();
  });

  it("[NFR-005] makes no copy for strict mode's practice run, only for a real removal", async () => {
    allowMotion();
    const { unmount } = render(
      <StrictMode>
        <div ref={leaveMotion} className="palette" />
      </StrictMode>,
    );
    await Promise.resolve();
    expect(melting()).toBeNull();
    unmount();
    await waitFor(() => expect(melting()).not.toBeNull());
  });
});

describe('playMotion (ADR-114)', () => {
  it('[NFR-005] plays a class once and takes it away at the end', () => {
    const card = document.createElement('li');
    const inner = document.createElement('a');
    card.append(inner);
    playMotion(card, 'motion-drop');
    expect(card).toHaveClass('motion-drop');
    fireEvent.animationEnd(inner);
    expect(card).toHaveClass('motion-drop');
    fireEvent.animationEnd(card);
    expect(card).not.toHaveClass('motion-drop');
  });

  it('[NFR-005] starts again when it is still running', () => {
    const cancel = vi.fn();
    const play = vi.fn();
    const region = document.createElement('div');
    region.getAnimations = () => [{ cancel, play } as unknown as Animation];
    playMotion(region, 'motion-rise');
    expect(cancel).not.toHaveBeenCalled();
    playMotion(region, 'motion-rise');
    expect(cancel).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });
});

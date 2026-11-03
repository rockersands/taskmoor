import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Timeline } from './client';
import { manyItems } from './fixtures';
import { TimelineView } from './TimelineView';

const ROW = 44;

function view(data: Timeline) {
  return (
    <I18nProvider locale="en">
      <TimelineView
        data={data}
        reschedule={async () => ({ ok: true })}
        reload={() => {}}
        now={() => new Date('2026-11-04T09:00:00Z')}
        truncatedText="cut"
      />
    </I18nProvider>
  );
}

/** jsdom has no layout: the scroll position is whatever the test says it is. */
function scrollTo(top: number) {
  const el = document.querySelector('.timeline-scroll') as HTMLElement;
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: top });
  act(() => {
    fireEvent.scroll(el);
  });
}

beforeEach(() => {
  // Scroll steps land at once.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a long timeline (PLN-012)', () => {
  it('[PLN-012] draws the rows where the list stands when it is windowed again', () => {
    const { rerender } = render(view(manyItems(300)));
    expect(screen.getByRole('link', { name: 'LCH-1' })).toBeInTheDocument();
    scrollTo(150 * ROW);
    expect(screen.queryByRole('link', { name: 'LCH-1' })).toBeNull();
    expect(screen.getByRole('link', { name: 'LCH-151' })).toBeInTheDocument();
    // A filter leaves 150 rows: no windowing, and the browser puts the list back at the top.
    rerender(view(manyItems(150)));
    const el = document.querySelector('.timeline-scroll') as HTMLElement;
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0 });
    // Cleared: 300 rows again, windowed from the top where the list now stands.
    rerender(view(manyItems(300)));
    expect(screen.getByRole('link', { name: 'LCH-1' })).toBeInTheDocument();
  });

  it('[PLN-012] keeps the focused bar drawn, and focused, while it scrolls out of view', () => {
    render(view(manyItems(300)));
    const bar = screen.getByRole('button', { name: /^LCH-2: / });
    act(() => bar.focus());
    expect(document.activeElement).toBe(bar);
    scrollTo(150 * ROW);
    expect(screen.queryByRole('link', { name: 'LCH-3' })).toBeNull();
    expect(bar).toBeInTheDocument();
    expect(document.activeElement).toBe(bar);
    // It stays at its own place, out of the rows in view.
    expect((bar.closest('li') as HTMLElement).style.top).toBe(`${1 * ROW}px`);
    // Back in view, it is an ordinary row again, still focused.
    scrollTo(0);
    expect(document.activeElement).toBe(bar);
    expect((bar.closest('li') as HTMLElement).style.position).toBe('');
  });
});

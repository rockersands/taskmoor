import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_ON_A_TOUCH_SCREEN, onARealTouchScreen } from './touch';

const pointer = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
  }));
const asAStoryTest = (yes: boolean) => vi.stubGlobal('taskmoorStoryTest', yes || undefined);

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

// Touch stories run in projects whose browser is a touch screen from the start (T-328); the
// story's beforeEach only checks that it is on one.
describe('onARealTouchScreen', () => {
  it('[NFR-007] lets a story test on a touch screen measure, and leaves the page as it was', async () => {
    asAStoryTest(true);
    pointer(true);
    const takeAway = await onARealTouchScreen();
    expect(document.head.querySelector('style')).toBeNull();
    await takeAway();
  });

  it('[NFR-007] fails a story test with a mouse, naming the tag that it lacks', async () => {
    asAStoryTest(true);
    pointer(false);
    await expect(onARealTouchScreen()).rejects.toThrow(NOT_ON_A_TOUCH_SCREEN);
    expect(NOT_ON_A_TOUCH_SCREEN).toContain("tags: ['touch']");
  });

  it("[NFR-007] puts the touch rules in force by hand on Storybook's own page", async () => {
    asAStoryTest(false);
    pointer(false);
    const sheet = document.createElement('style');
    sheet.textContent = '@media (pointer: coarse) { .grip { min-height: 44px; } }';
    document.head.append(sheet);
    const takeAway = await onARealTouchScreen();
    const added = document.head.querySelectorAll('style')[1];
    expect(added?.textContent).toContain('min-height: 44px');
    await takeAway();
    expect(document.head.querySelectorAll('style')).toHaveLength(1);
  });
});

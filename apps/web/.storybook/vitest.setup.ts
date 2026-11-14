import { setProjectAnnotations } from '@storybook/react-vite';
import { afterAll, beforeAll } from 'vitest';
import { cdp } from 'vitest/browser';
import * as previewAnnotations from './preview';

// The skin this run of the story tests renders in (ADR-036); the preview's decorator paints it.
// Storybook's own toolbar decides outside tests.
(globalThis as { taskmoorStorySkin?: string }).taskmoorStorySkin =
  import.meta.env.STORY_SKIN ?? 'light';

// A real touch screen for a story that asks for one (`onARealTouchScreen` in src/test/touch.ts):
// Chromium's touch emulation makes `(pointer: coarse)` true for the whole page, so the style
// sheets' touch rules apply in their own places in the cascade, as on a phone (T-255).
let touchScreen = false;
const switchTouchScreen = async (on: boolean) => {
  await cdp().send(
    'Emulation.setTouchEmulationEnabled',
    on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
  );
  touchScreen = on;
};
(globalThis as { taskmoorTouchScreen?: (on: boolean) => Promise<void> }).taskmoorTouchScreen =
  switchTouchScreen;

// Storybook runs a story's `beforeEach` cleanup only when the next story of the file starts, so
// the file's last story would leave the emulation on. It belongs to the browser page, not the
// file, and the page runs the worker's next story file: a desktop story then measured touch
// sizes (Shell/Checks saw 20 and 28 px boxes side by side). Each file ends with a mouse again.
afterAll(async () => {
  if (touchScreen) await switchTouchScreen(false);
});

const project = setProjectAnnotations([previewAnnotations]);

beforeAll(project.beforeAll);

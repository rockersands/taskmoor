import { setProjectAnnotations } from '@storybook/react-vite';
import { beforeAll } from 'vitest';
import { cdp } from 'vitest/browser';
import * as previewAnnotations from './preview';

// The skin this run of the story tests renders in (ADR-036); the preview's decorator paints it.
// Storybook's own toolbar decides outside tests.
(globalThis as { taskmoorStorySkin?: string }).taskmoorStorySkin =
  import.meta.env.STORY_SKIN ?? 'light';

// A real touch screen for a story that asks for one (`onARealTouchScreen` in src/test/touch.ts):
// Chromium's touch emulation makes `(pointer: coarse)` true for the whole page, so the style
// sheets' touch rules apply in their own places in the cascade, as on a phone (T-255).
(globalThis as { taskmoorTouchScreen?: (on: boolean) => Promise<void> }).taskmoorTouchScreen =
  async (on) => {
    await cdp().send(
      'Emulation.setTouchEmulationEnabled',
      on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    );
  };

const project = setProjectAnnotations([previewAnnotations]);

beforeAll(project.beforeAll);

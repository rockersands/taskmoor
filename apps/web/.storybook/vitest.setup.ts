import { setProjectAnnotations } from '@storybook/react-vite';
import { beforeAll } from 'vitest';
import * as previewAnnotations from './preview';

// The skin this run of the story tests renders in (ADR-036); the preview's decorator paints it.
// Storybook's own toolbar decides outside tests.
(globalThis as { taskmoorStorySkin?: string }).taskmoorStorySkin =
  import.meta.env.STORY_SKIN ?? 'light';

// A story test, not Storybook's own page: `onARealTouchScreen` (src/test/touch.ts) then expects
// the browser to be a touch screen already, as the touch projects' browsers are (T-328).
(globalThis as { taskmoorStoryTest?: boolean }).taskmoorStoryTest = true;

const project = setProjectAnnotations([previewAnnotations]);

beforeAll(project.beforeAll);

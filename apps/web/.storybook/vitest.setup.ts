import * as a11yAddonAnnotations from '@storybook/addon-a11y/preview';
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

// Every story is an accessibility test (ADR-024): the a11y addon's annotations bring the axe
// check that runs after each story. A setup file that calls `setProjectAnnotations` turns off the
// Storybook plugin's own provisioning, so it must list the addons' annotations itself, before the
// preview's, whose `a11y.test: 'error'` then wins over the addon's 'todo'. Without them no story
// ran axe (T-327); `src/test/storyAxe.test.tsx` fails if they go missing again.
const project = setProjectAnnotations([a11yAddonAnnotations, previewAnnotations]);

beforeAll(project.beforeAll);

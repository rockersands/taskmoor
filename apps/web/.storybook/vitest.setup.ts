import * as a11yAddonAnnotations from '@storybook/addon-a11y/preview';
// axe itself, loaded with each story file, not inside its first story (T-327). The addon imports
// axe only when its first check runs, in the afterEach of the first story in a file, so that story
// paid inside its 15 s for fetching axe's 1.4 MB bundle from the project's Vite server and
// evaluating it: 0.3 s alone, 0.7 s while a full stories run shared the same Node process. The
// first story of the first touch files is where a full gate's timeouts fell (ADR-024). The addon
// then finds the same module, already evaluated.
import 'axe-core';
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

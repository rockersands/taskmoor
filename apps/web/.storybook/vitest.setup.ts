import * as a11yAddonAnnotations from '@storybook/addon-a11y/preview';
// axe itself, loaded with each story file, not inside its first story (T-327). The addon imports
// axe when its first check runs, in the afterEach of the first story of a file, and that story
// then waited inside its 15 s for the 1.4 MB bundle from the project's Vite server: up to 3.3 s
// in a full run. The addon finds the same module, already evaluated. This alone did not stop the
// gate's timeouts (the story report below did, ADR-024).
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
//
// The axe report a story test keeps is its violations, whole, and nothing else (T-327). The
// addon puts axe's result in the test's meta, which the page sends to Vitest's main process; with
// every passing, incomplete and inapplicable rule and its elements that was about 1 MB for a
// ticket page. In a full run the main process spent seconds at a stretch parsing those messages,
// and a story waiting on its Vite server then timed out (ADR-024). `no-passes` is axe's own
// reporter for this: every rule still runs on every element, a violation still fails the story,
// listed with its elements, and Storybook's own page keeps the whole result.
const storyTestReport = { parameters: { a11y: { options: { reporter: 'no-passes' } } } };
const project = setProjectAnnotations([a11yAddonAnnotations, previewAnnotations, storyTestReport]);

beforeAll(project.beforeAll);

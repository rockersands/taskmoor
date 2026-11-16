import type { Meta, StoryObj } from '@storybook/react-vite';
import { composeStory } from '@storybook/react-vite';
import { describe, expect, it } from 'vitest';
// The story tests' own setup file (vitest.stories.config.ts): it sets the project annotations
// every story test composes its stories with.
import '../../.storybook/vitest.setup';

/** A page with the three mistakes axe must never let through: no name, no alt, no label. */
function Nameless() {
  return (
    <main>
      <button type="button" />
      {/* biome-ignore lint/a11y/useAltText: the probe's missing alt is what axe must catch. */}
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
      <input type="text" />
    </main>
  );
}

const meta = { title: 'Guards/Nameless', component: Nameless } satisfies Meta<typeof Nameless>;
const Probe: StoryObj<typeof meta> = {};

type A11yReport = {
  type: string;
  status: string;
  result: { violations?: { id: string }[] };
};

// ADR-024: every story is an accessibility test. A setup file that calls setProjectAnnotations
// without the a11y addon's annotations turns axe off for every story, silently (T-327).
describe('story tests', () => {
  it('[NFR-005] run axe after every story and fail one with a nameless button', async () => {
    const story = composeStory(Probe, meta);
    const reporting = {
      reports: [] as A11yReport[],
      async addReport(report: A11yReport) {
        this.reports.push(report);
      },
    };
    const canvasElement = document.body.appendChild(document.createElement('div'));

    await story.run({ canvasElement, reporting } as never);

    const a11y = reporting.reports.find((report) => report.type === 'a11y');
    expect(a11y, 'the a11y addon ran no axe check').toBeDefined();
    // 'failed' is the preview's `a11y.test: 'error'`; the addon alone would only warn ('warning').
    expect(a11y?.status).toBe('failed');
    expect(a11y?.result.violations?.map((v) => v.id)).toEqual(
      expect.arrayContaining(['button-name', 'image-alt', 'label']),
    );
  });
});

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

/** Two nameless buttons beside named ones: a violation on two elements, passes on others. */
function TwoNameless() {
  return (
    <main>
      <button type="button" />
      <button type="button">Save</button>
      <button type="button" />
      <button type="button">Cancel</button>
    </main>
  );
}

const meta = { title: 'Guards/Nameless', component: Nameless } satisfies Meta<typeof Nameless>;
const Probe: StoryObj<typeof meta> = {};
const twoMeta = {
  title: 'Guards/TwoNameless',
  component: TwoNameless,
} satisfies Meta<typeof TwoNameless>;
const TwoProbe: StoryObj<typeof twoMeta> = {};

type A11yReport = {
  type: string;
  status: string;
  result: {
    violations?: { id: string; nodes: { html: string; target: unknown[] }[] }[];
    passes?: unknown[];
    incomplete?: unknown[];
    inapplicable?: unknown[];
  };
};

/** Runs a composed story as the story tests do and returns its a11y report. */
async function a11yReportOf(story: { run: (context: never) => Promise<void> }) {
  const reporting = {
    reports: [] as A11yReport[],
    async addReport(report: A11yReport) {
      this.reports.push(report);
    },
  };
  const canvasElement = document.body.appendChild(document.createElement('div'));
  try {
    await story.run({ canvasElement, reporting } as never);
  } finally {
    canvasElement.remove();
  }
  return reporting.reports.find((report) => report.type === 'a11y');
}

// ADR-024: every story is an accessibility test. A setup file that calls setProjectAnnotations
// without the a11y addon's annotations turns axe off for every story, silently (T-327).
describe('story tests', () => {
  it('[NFR-005] run axe after every story and fail one with a nameless button', async () => {
    const a11y = await a11yReportOf(composeStory(Probe, meta));
    expect(a11y, 'the a11y addon ran no axe check').toBeDefined();
    // 'failed' is the preview's `a11y.test: 'error'`; the addon alone would only warn ('warning').
    expect(a11y?.status).toBe('failed');
    expect(a11y?.result.violations?.map((v) => v.id)).toEqual(
      expect.arrayContaining(['button-name', 'image-alt', 'label']),
    );
  });

  // The report travels from the story's page to Vitest's main process in the test's meta. With
  // axe's whole result it was about 1 MB for a ticket page, and parsing thousands of them stalled
  // the main process long enough to time out stories in a full run (ADR-024, T-327).
  it('[NFR-005] report every element of a violation and leave out the passing rules', async () => {
    const a11y = await a11yReportOf(composeStory(TwoProbe, twoMeta));

    expect(a11y?.status).toBe('failed');
    const nameless = a11y?.result.violations?.find((v) => v.id === 'button-name');
    expect(nameless?.nodes).toHaveLength(2);
    for (const node of nameless?.nodes ?? []) {
      expect(node.html).toBe('<button type="button"></button>');
      expect(node.target).toHaveLength(1);
    }
    expect(a11y?.result.passes).toBeUndefined();
    expect(a11y?.result.incomplete).toBeUndefined();
    expect(a11y?.result.inapplicable).toBeUndefined();
  });
});

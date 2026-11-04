import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../App';
import { messagesEn } from '../i18n/messages.en';
import { messagesEs } from '../i18n/messages.es';
import { TRACK_SECTIONS } from '../tracks/TrackLayout';
import { NOBODY, TUTORIAL_SECTIONS } from './sections';
import { remember, stepBodyId, stepTitleId, TUTORIAL_STEPS } from './steps';

/**
 * The tutorial's markers (ADR-115): every control a step rings or waits for carries its
 * `data-tutorial` marker in the app's source, so a restyled or rebuilt page that drops one fails
 * here, before release. Read from disk, as motion.test.ts does.
 */
const SRC = ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'tutorial/steps.ts'))) ?? 'src';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every marker the app sets: written out, or built from the navigation and the track tabs. */
function markersInApp(): Set<string> {
  const markers = new Set<string>();
  const text = sources(SRC)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  for (const match of text.matchAll(/data-tutorial="([a-z0-9-]+)"/g)) markers.add(match[1] ?? '');
  if (/data-tutorial=\{`nav-\$\{id\}`\}/.test(text)) {
    for (const item of NAV_ITEMS) markers.add(`nav-${item.id}`);
  }
  if (/data-tutorial=\{`track-tab-\$\{s\.id\}`\}/.test(text)) {
    for (const section of TRACK_SECTIONS) markers.add(`track-tab-${section.id}`);
  }
  return markers;
}

describe('the tutorial steps (ADR-115)', () => {
  const markers = markersInApp();
  const everyStep = TUTORIAL_SECTIONS.flatMap((section) =>
    TUTORIAL_STEPS[section.id].map((step) => ({ section: section.id, step })),
  );

  it('[AGL-025] ring and wait for controls the app marks', () => {
    const wanted = everyStep.flatMap(({ section, step }) => [
      ...(step.target ? [{ section, step: step.id, marker: step.target }] : []),
      ...(step.done ?? []).flatMap((done) =>
        'appears' in done ? [{ section, step: step.id, marker: done.appears }] : [],
      ),
    ]);
    expect(wanted.length).toBeGreaterThan(30);
    expect(wanted.filter((w) => !markers.has(w.marker))).toEqual([]);
  });

  it('[AGL-025] open with what the section makes and close with the way to it', () => {
    for (const section of TUTORIAL_SECTIONS) {
      const steps = TUTORIAL_STEPS[section.id];
      expect(steps[0]?.id, section.id).toBe('intro');
      expect(steps.at(-1)?.id, section.id).toBe('finish');
      expect(steps.at(-1)?.made, section.id).toBeTypeOf('function');
      expect(new Set(steps.map((s) => s.id)).size, section.id).toBe(steps.length);
      // Something real is made: at least one step waits for the server to take a change.
      expect(
        steps.some((s) => s.done?.some((d) => 'request' in d)),
        section.id,
      ).toBe(true);
    }
  });

  it('[AGL-025] have a title and a body in English and in Spanish', () => {
    const missing = everyStep.flatMap(({ section, step }) =>
      [stepTitleId(section, step), stepBodyId(section, step)].filter(
        (id) => !(id in messagesEn) || !(id in messagesEs),
      ),
    );
    expect(missing).toEqual([]);
  });

  it('[AGL-025] remember what the person opened, to lead back to it', () => {
    const memory = remember({}, [
      '#/tracks/WEB/board',
      '#/tickets/WEB-4',
      '#/dashboards/12',
      '#/releases/3',
      '#/admin/workflows/8',
    ]);
    expect(memory).toEqual({
      track: 'WEB',
      ticket: 'WEB-4',
      dashboard: '12',
      release: '3',
      workflow: '8',
    });
    // Nothing new: the same object, so nothing renders again.
    expect(remember(memory, ['#/tracks/WEB', null, '#/search'])).toBe(memory);
    expect(remember({}, ['#/tracks?new'])).toEqual({});
  });

  it('[AGL-025] a person with no rights is offered only the everyday sections', () => {
    expect(TUTORIAL_SECTIONS.filter((s) => s.who === 'everyone').map((s) => s.id)).toEqual([
      'tracks',
      'boards',
      'search',
      'dashboards',
      'releases',
    ]);
    expect(NOBODY).toEqual({ siteAdmin: false, setupAdmin: false, makesTracks: false });
  });
});

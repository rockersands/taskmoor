import { describe, expect, it } from 'vitest';
import { summarise } from './summary.mjs';

const capture = (slug, width, skin, more = {}) => ({
  id: `${slug}--${width}--${skin}`,
  slug,
  width,
  skin,
  console: [],
  failed: [],
  ...more,
});
const small = (name, w = 30, h = 44) => ({ role: 'button', name, width: w, height: h });
const name = (n, visible) => ({ role: 'button', name: n, visible, leftOut: ['x'] });

describe('summarise', () => {
  it('[NFR-005] counts small controls once, from the light phone pictures', () => {
    const { counts, worst } = summarise([
      capture('ticket', 375, 'light', { small: [small('Edit'), small('Tab All', 42, 44)] }),
      capture('ticket', 375, 'dark', { small: [small('Edit'), small('Tab All', 42, 44)] }),
      capture('search', 375, 'light', { small: [small('Edit')] }),
    ]);
    expect(counts.smallControlsDistinct).toBe(2);
    expect(worst.smallControlsByPage).toEqual([
      { what: 'ticket', count: 2 },
      { what: 'search', count: 1 },
    ]);
    expect(worst.smallControls).toEqual([
      { what: 'button "Edit" 30x44', count: 2 },
      { what: 'button "Tab All" 42x44', count: 1 },
    ]);
  });

  it('[NFR-007] keeps sideways scroll apart per width, with the widest overflow per page', () => {
    const { counts, worst } = summarise([
      capture('account', 375, 'light', {
        sideways: { over: 0 },
        sideways360: { over: 8 },
      }),
      capture('board', 375, 'light', { sideways: { over: 12 } }),
      capture('board', 375, 'dark', { sideways: { over: 20 } }),
      capture('admin', 1280, 'light', { sideways: { over: 3 } }),
    ]);
    expect(counts).toMatchObject({ sidewaysAt375: 1, sidewaysAt360: 1, sidewaysAt1280: 1 });
    expect(worst.sidewaysAt375).toEqual([{ what: 'board', count: 20 }]);
    expect(worst.sidewaysAt360).toEqual([{ what: 'account', count: 8 }]);
    expect(worst.sidewaysAt1280).toEqual([{ what: 'admin', count: 3 }]);
  });

  it('[NFR-005] adds up axe nodes per rule and per page', () => {
    const rule = (id, nodes) => ({ id, impact: 'serious', nodes, targets: [] });
    const { counts, worst } = summarise([
      capture('ticket', 1280, 'light', { axe: [rule('label-content-name-mismatch', 3)] }),
      capture('ticket', 375, 'light', { axe: [rule('label-content-name-mismatch', 2)] }),
      capture('usage', 375, 'light', { axe: [rule('scrollable-region-focusable', 1)] }),
    ]);
    expect(counts.axeRules).toBe(2);
    expect(counts.axeNodes).toBe(6);
    expect(worst.axeByRule[0]).toEqual({ what: 'label-content-name-mismatch (serious)', count: 5 });
    expect(worst.axeByPage).toEqual([
      { what: 'ticket', count: 5 },
      { what: 'usage', count: 1 },
    ]);
  });

  it('[NFR-005] counts names that leave out visible words at 1280 in the light skin only', () => {
    const left = name('Rename the checklist', 'Edit');
    const { counts, worst } = summarise([
      capture('ticket', 1280, 'light', { names: [left] }),
      capture('ticket', 1280, 'dark', { names: [left] }),
      capture('ticket', 375, 'light', { names: [left] }),
    ]);
    expect(counts.namesLeavingOutWordsDistinct).toBe(1);
    expect(worst.namesLeavingOutWords).toEqual([
      { what: 'button named "Rename the checklist" shows "Edit"', count: 1 },
    ]);
  });

  it('[NFR-007] counts errors, failed states, unsettled pages and pictures not as a phone shows', () => {
    const summary = summarise([
      capture('a', 375, 'light', { error: 'took over 90 s', console: ['401'], failed: ['x'] }),
      capture('b', 375, 'light', { stateFailed: 'no grip', console: ['401'] }),
      capture('c', 375, 'dark', { settled: false, pictureProblem: 'no touch pointer' }),
      capture('d', 1280, 'dark', { settled: true }),
    ]);
    expect(summary).toMatchObject({
      captures: 4,
      errors: 1,
      statesThatFailed: 1,
      notSettled: 1,
      picturesNotAsAPhone: 1,
    });
    expect(summary.counts.consoleErrorsDistinct).toBe(1);
    expect(summary.worst.consoleErrors).toEqual([{ what: '401', count: 2 }]);
    expect(summary.counts.failedRequestsDistinct).toBe(1);
  });

  it('[NFR-005] lists at most thirty of the worst, most first and then by name', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      capture(`p${String(i).padStart(2, '0')}`, 375, 'light', { small: [small(`b${i}`)] }),
    );
    const { worst } = summarise(many);
    expect(worst.smallControlsByPage).toHaveLength(30);
    expect(worst.smallControlsByPage[0]).toEqual({ what: 'p00', count: 1 });
    expect(summarise([]).counts.axeNodes).toBe(0);
  });
});

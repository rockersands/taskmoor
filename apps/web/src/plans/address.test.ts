import { describe, expect, it } from 'vitest';
import { PLAN_ROUTE, planHref, planViewKey, readView } from './address';

/** A view in the address (PLN-012), and where it stands (PLN-014). */
describe('a plan view in the address', () => {
  it('[PLN-014] reads and writes the zoom, the month, the first day and the order', () => {
    const route = '#/plans/12/timeline?track=SHOP&group=type&zoom=months';
    const view = readView(route);
    expect(view.position).toEqual({ zoom: 'months' });
    expect(planHref(12, 'timeline', view)).toBe(route);

    for (const [key, value] of [
      ['zoom', 'quarters'],
      ['month', '2027-02'],
      ['from', '2027-02-28'],
      ['sort', 'priority'],
      // The Timeline's critical path (PLN-011), so a link keeps it on.
      ['critical', '1'],
    ] as const) {
      const read = readView(`#/plans/12?${key}=${value}`);
      expect(read.position).toEqual({ [key]: value });
      expect(planHref(12, 'summary', read)).toBe(`#/plans/12?${key}=${value}`);
    }
    // All at once, and with nothing the address holds no query.
    const all = '#/plans/12/list?assignee=me&zoom=weeks&month=2027-02&from=2027-02-28&sort=due';
    expect(planHref(12, 'list', readView(all))).toBe(all);
    expect(planHref(12, 'list', readView('#/plans/12/list'))).toBe('#/plans/12/list');
  });

  it('[PLN-014] leaves out values that could not be meant', () => {
    for (const bad of [
      'zoom=years',
      'zoom=',
      'month=2027-13',
      'month=2027-2',
      'month=<script>',
      'from=2027-02-30',
      'from=tomorrow',
      'from=2027-2-1',
      'sort=summary',
      'sort=created%20DESC',
      'critical=yes',
      'critical=0',
    ]) {
      expect(readView(`#/plans/12?${bad}`).position, bad).toEqual({});
    }
  });

  it('[PLN-014] a change of where the view stands does not change what the plan is read for', () => {
    const base = readView('#/plans/12?track=SHOP&group=status');
    const moved = readView('#/plans/12?track=SHOP&group=status&zoom=months&month=2027-02&sort=due');
    expect(planViewKey(12, moved)).toBe(planViewKey(12, base));
    const filtered = readView('#/plans/12?track=OPS&group=status&zoom=months');
    expect(planViewKey(12, filtered)).not.toBe(planViewKey(12, base));
    const grouped = readView('#/plans/12?track=SHOP&group=type');
    expect(planViewKey(12, grouped)).not.toBe(planViewKey(12, base));
  });

  it('[PLN-002] keeps the scenario read in the address, so a link opens the same one', () => {
    const route = '#/plans/12/timeline?track=SHOP&zoom=months&scenario=4';
    const view = readView(route);
    expect(view.scenario).toBe(4);
    expect(planHref(12, 'timeline', view)).toBe(route);
    // Another tab keeps it; Live has none.
    expect(planHref(12, 'calendar', view)).toBe(
      '#/plans/12/calendar?track=SHOP&zoom=months&scenario=4',
    );
    expect(readView('#/plans/12/timeline').scenario).toBeUndefined();
    // A change of scenario reads the plan again; where the view stands still does not.
    const live = readView('#/plans/12/timeline?track=SHOP');
    expect(planViewKey(12, view)).not.toBe(planViewKey(12, live));
    expect(planViewKey(12, readView(`${route}&month=2027-02`))).toBe(planViewKey(12, view));
    for (const bad of ['scenario=0', 'scenario=-1', 'scenario=x', 'scenario=99999999999']) {
      expect(readView(`#/plans/12?${bad}`).scenario, bad).toBeUndefined();
    }
  });

  it('[PLN-003] keeps the two sides compared on the Scenarios tab only', () => {
    const route = '#/plans/12/scenarios?scenario=4&a=live&b=7';
    const view = readView(route);
    expect(view.compare).toEqual({ a: 'live', b: '7' });
    expect(planHref(12, 'scenarios', view)).toBe(route);
    expect(planHref(12, 'timeline', view)).toBe('#/plans/12/timeline?scenario=4');
    expect(readView('#/plans/12/scenarios?a=main&b=0').compare).toBeUndefined();
  });

  it('[PLN-002] routes the Changes and Scenarios tabs', () => {
    expect(PLAN_ROUTE.exec('#/plans/12/changes?scenario=4')?.[2]).toBe('changes');
    expect(PLAN_ROUTE.exec('#/plans/12/scenarios')?.[2]).toBe('scenarios');
  });
});

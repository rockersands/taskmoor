import { describe, expect, it } from 'vitest';
import { formatPlan, loadPlan } from './next-task';

describe('the real plan files', () => {
  // Fails when someone edits backlog.csv or progress.csv into an inconsistent state.
  it('load without problems and leave work to do', () => {
    const plan = loadPlan();
    expect(plan.total).toBeGreaterThan(200);
    expect(plan.inProgress.length + plan.ready.length).toBeGreaterThan(0);
  });

  it('format into a short report that names the next task', () => {
    const text = formatPlan(loadPlan());
    expect(text).toMatch(/^(Resume|Next): M\d-\d{3} /);
    expect(text).toMatch(/Done: \d+ of \d+ tasks$/);
  });
});

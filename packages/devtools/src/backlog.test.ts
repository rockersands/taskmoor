import { describe, expect, it } from 'vitest';
import {
  type ProgressEntry,
  parseBacklog,
  parseDependencies,
  parseProgress,
  planWork,
  type Task,
  validateBacklog,
} from './backlog';

const task = (id: string, dependsOn: string[] = []): Task => ({
  id,
  milestone: id.slice(0, 2),
  epic: 'E',
  title: `Task ${id}`,
  dependsOn,
  doneWhen: 'tests pass',
  size: 'S',
  modules: 'OPS',
});

const progress = (id: string, state: ProgressEntry['state']): ProgressEntry => ({
  id,
  state,
  date: '2026-10-12',
  note: '',
});

describe('parseDependencies', () => {
  it('reads none, single IDs and lists separated by semicolons or commas', () => {
    expect(parseDependencies('None')).toEqual([]);
    expect(parseDependencies('  ')).toEqual([]);
    expect(parseDependencies('M0-001')).toEqual(['M0-001']);
    expect(parseDependencies('M0-018; M0-019,M0-020')).toEqual(['M0-018', 'M0-019', 'M0-020']);
  });

  it('expands inclusive ranges and keeps zero padding', () => {
    expect(parseDependencies('M2-008..M2-011')).toEqual(['M2-008', 'M2-009', 'M2-010', 'M2-011']);
    expect(parseDependencies('M0-034; M3-001..M3-002')).toEqual(['M0-034', 'M3-001', 'M3-002']);
  });

  it('rejects malformed IDs and ranges', () => {
    expect(() => parseDependencies('M0-01x')).toThrow(/Bad task ID/);
    expect(() => parseDependencies('M1-005..M2-001')).toThrow(/spans milestones/);
    expect(() => parseDependencies('M1-009..M1-002')).toThrow(/backwards/);
    expect(() => parseDependencies('M1-001..M1-002..M1-003')).toThrow(/Bad dependency/);
  });
});

describe('validateBacklog', () => {
  it('accepts a well-formed backlog', () => {
    expect(validateBacklog([task('M0-001'), task('M0-002', ['M0-001'])])).toEqual([]);
  });

  it('reports duplicates, unknown dependencies, unknown progress rows and cycles', () => {
    const problems = validateBacklog(
      [
        task('M0-001', ['M0-003']),
        task('M0-002', ['M0-009']),
        task('M0-002'),
        task('M0-003', ['M0-001']),
      ],
      [progress('M9-999', 'done')],
    );
    expect(problems).toContain('Duplicate task M0-002');
    expect(problems).toContain('M0-002 depends on unknown task M0-009');
    expect(problems).toContain('Progress entry for unknown task M9-999');
    expect(problems).toContain('Dependency cycle: M0-001 -> M0-003 -> M0-001');
  });
});

describe('planWork', () => {
  const tasks = [
    task('M0-001'),
    task('M0-002', ['M0-001']),
    task('M0-003', ['M0-001', 'M0-002']),
    task('M0-004'),
    task('M0-005'),
  ];

  it('offers tasks whose dependencies are all done, in backlog order', () => {
    const plan = planWork(tasks, [progress('M0-001', 'done')]);
    expect(plan.ready.map((t) => t.id)).toEqual(['M0-002', 'M0-004', 'M0-005']);
    expect(plan.done).toBe(1);
    expect(plan.total).toBe(5);
  });

  it('separates in-progress and waiting tasks, and does not unblock their dependants', () => {
    const plan = planWork(tasks, [
      progress('M0-001', 'done'),
      progress('M0-002', 'in-progress'),
      progress('M0-004', 'waiting-on-user'),
    ]);
    expect(plan.inProgress.map((t) => t.id)).toEqual(['M0-002']);
    expect(plan.waitingOnUser.map((t) => t.id)).toEqual(['M0-004']);
    expect(plan.ready.map((t) => t.id)).toEqual(['M0-005']);
  });
});

describe('parsing the plan files', () => {
  it('maps backlog columns to tasks', () => {
    const [t] = parseBacklog(
      'Task ID,Milestone,Epic,Task,Depends on,Done when,Size,Modules\n' +
        'M0-002,M0,Repo,"Write CLAUDE.md, HANDOFF.md",M0-001,"check passes",S,OPS\n',
    );
    expect(t).toEqual({
      id: 'M0-002',
      milestone: 'M0',
      epic: 'Repo',
      title: 'Write CLAUDE.md, HANDOFF.md',
      dependsOn: ['M0-001'],
      doneWhen: 'check passes',
      size: 'S',
      modules: 'OPS',
    });
  });

  it('rejects unknown progress states', () => {
    expect(() => parseProgress('Task ID,State,Date,Note\nM0-001,finished,2026-10-12,\n')).toThrow(
      /Unknown state "finished"/,
    );
  });
});

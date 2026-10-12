import { describe, expect, it } from 'vitest';
import type { ConformanceCase } from './case';
import { actor, item, W1 } from './cases/fixtures';
import { formatReport, mismatch, runCase, runConformance, type WorkflowEngine } from './run';

const available: ConformanceCase = {
  id: 'WF-001-x-01',
  requirement: 'WF-001',
  section: 'model',
  title: 'x',
  spec: '01a 3.1',
  kind: 'available',
  workflow: W1,
  item: item(),
  actor: actor('alice'),
  expect: { transitions: ['start', 'cancel'] },
};

const transition: ConformanceCase = {
  id: 'WF-004-y-01',
  requirement: 'WF-004',
  section: 'validators',
  title: 'y',
  spec: '01a 3.3',
  kind: 'transition',
  workflow: W1,
  item: item(),
  actor: actor('alice'),
  request: { transition: 'start' },
  expect: { outcome: 'blocked', by: 'validator', name: 'field-required' },
};

describe('subset matching', () => {
  it('[WF-001] compares only the keys the expectation names, arrays exactly', () => {
    expect(mismatch({ a: 1, b: 2 }, { a: 1 })).toBeUndefined();
    expect(mismatch({ a: 1 }, { a: 2 })).toBe('a: expected 2, got 1');
    expect(mismatch({ a: [1, 2] }, { a: [1] })).toBe('a: expected 1 entries, got 2');
    expect(mismatch({ a: [{ x: 1, y: 2 }] }, { a: [{ x: 1 }] })).toBeUndefined();
    expect(mismatch({ a: null }, { a: { x: 1 } })).toBe('a: expected an object');
    expect(mismatch(undefined, { x: 1 }, 'root')).toBe('root: expected an object');
  });
});

describe('runner', () => {
  it('[WF-001] counts a missing engine method as unsupported, not failed', () => {
    const report = runConformance({}, [available, transition]);
    expect(report.unsupported).toBe(2);
    expect(report.fail).toBe(0);
    expect(report.sections.map((s) => s.section)).toEqual(['model', 'validators']);
    expect(formatReport(report)).toContain('model');
    expect(formatReport(report)).not.toContain('Failures');
  });

  it('[WF-004] fails a transition case whose outcome differs and names the difference', () => {
    const engine: WorkflowEngine = {
      transition: (_w, i) => ({
        outcome: 'ok',
        item: { ...i, status: 'in-progress' },
        order: [],
        event: 'generic',
        webhooks: [],
        notificationsAfterSequence: true,
      }),
    };
    const result = runCase(engine, transition);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('expected "blocked"');
    expect(formatReport(runConformance(engine, [transition]))).toContain('Failures:');
  });

  it('[WF-004] fails a blocked transition that changed the item anyway', () => {
    const engine: WorkflowEngine = {
      transition: (_w, i) => ({
        outcome: 'blocked',
        by: 'validator',
        name: 'field-required',
        item: { ...i, fields: { leaked: true } },
      }),
    };
    const result = runCase(engine, transition);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('must be unchanged');
  });

  it('[WF-001] reports an engine that throws as a failure with the message', () => {
    const engine: WorkflowEngine = {
      availableTransitions: () => {
        throw new Error('boom');
      },
    };
    expect(runCase(engine, available)).toMatchObject({ status: 'fail', detail: 'threw: boom' });
  });

  it('[WF-001] passes when the engine answers as expected, in any order', () => {
    const engine: WorkflowEngine = { availableTransitions: () => ['cancel', 'start'] };
    expect(runCase(engine, available).status).toBe('pass');
  });
});

import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type EventType } from '../events/catalogue';
import { AUDIT_ACTIONS } from './record';
import { AUDITED_EVENTS, NOT_AUDITED } from './subscriber';

describe('what the audit log records (M1-003)', () => {
  it('[IAM-013] decides for every domain event type: audited, or not with a reason', () => {
    const audited = new Set<string>(AUDITED_EVENTS);
    const excluded = Object.keys(NOT_AUDITED);
    const types = Object.keys(EVENT_TYPES) as EventType[];
    expect(
      types.filter((t) => !audited.has(t) && !excluded.includes(t)),
      'event types without a decision',
    ).toEqual([]);
    expect(
      excluded.filter((t) => audited.has(t)),
      'both audited and excluded',
    ).toEqual([]);
    expect([...audited].filter((t) => !types.includes(t as EventType))).toEqual([]);
    for (const reason of Object.values(NOT_AUDITED)) expect(reason?.length).toBeGreaterThan(10);
  });

  it('[PLN-004] [IAM-013] audits a run of the auto-scheduler beside the drafts it wrote', () => {
    expect(AUDITED_EVENTS).toContain('plan.schedule_ran');
    expect(AUDITED_EVENTS).toContain('plan.drafts_set');
  });

  it('[PLN-011] [IAM-013] audits capturing, renaming and deleting a baseline', () => {
    for (const type of [
      'plan.baseline_captured',
      'plan.baseline_renamed',
      'plan.baseline_deleted',
    ] as const) {
      expect(AUDITED_EVENTS).toContain(type);
    }
  });

  it('keeps the actions of records that are not events apart from event types', () => {
    for (const action of Object.values(AUDIT_ACTIONS)) {
      expect(Object.hasOwn(EVENT_TYPES, action), action).toBe(false);
    }
  });
});

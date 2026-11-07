import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { richDefinitionArb, workflowArb } from '../test/workflow';
import {
  addingNeedsCloseReason,
  addStatus,
  addStatusFreely,
  addTransition,
  formatDefinition,
  freeingSeed,
  freeingSeedNeedsCloseReason,
  isFreeMoving,
  jsonErrorOffset,
  nextTransitionId,
  removeStatus,
  removeTransition,
  sameDefinition,
  setInitialStatus,
  statusRemoval,
  strictSeedSteps,
  transitionIdsOf,
  updateTransition,
  type WorkflowDefinition,
  withRules,
} from './definition';
import { FREE_DEFINITION, S, STATUSES, STEPPED_DEFINITION, SUPPORT_DEFINITION } from './fixtures';
import { checkShape, parseDefinitionText } from './shape';

const codes = (value: unknown) => checkShape(value).map((p) => `${p.path} ${p.code}`);

describe('workflow definitions in the editor (M1-030)', () => {
  it('[WF-002] text mode and the diagram switch losslessly: the text reads back as the same definition', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          richDefinitionArb,
          workflowArb().map((w) => w.definition),
        ),
        (d) => {
          expect(checkShape(d)).toEqual([]);
          const read = parseDefinitionText(formatDefinition(d));
          expect(read.ok).toBe(true);
          if (read.ok) {
            expect(read.definition).toEqual(d);
            expect(formatDefinition(read.definition)).toBe(formatDefinition(d));
          }
        },
      ),
    );
  });

  it('[WF-002] the seeded workflows have the shape the server accepts', () => {
    expect(checkShape(STEPPED_DEFINITION)).toEqual([]);
    expect(checkShape(SUPPORT_DEFINITION)).toEqual([]);
  });

  it('[WF-002] a syntax error says where it is', () => {
    const read = parseDefinitionText('{\n  "initialStatusId": 1,\n  "statuses": [}\n');
    expect(read).toMatchObject({ ok: false, kind: 'syntax' });
    if (!read.ok && read.kind === 'syntax') expect(read.at?.line).toBe(3);
  });

  it('[WF-002] finds where JSON text breaks, and only when it does', () => {
    fc.assert(
      fc.property(
        fc.json(),
        fc.nat(),
        fc.constantFrom('', '}', ']', ',', '"', ':', 'x', '{', '[', '\\', '-', '0'),
        (json, at, insert) => {
          const cut = at % (json.length + 1);
          const text = json.slice(0, cut) + insert + json.slice(cut);
          let valid = true;
          try {
            JSON.parse(text);
          } catch {
            valid = false;
          }
          expect(jsonErrorOffset(text) === null).toBe(valid);
        },
      ),
    );
  });

  it('[WF-002] the shape check names each problem by its path', () => {
    expect(codes(null)).toEqual(['definition not_object']);
    expect(codes({ statuses: [], transitions: [], extra: 1 })).toEqual([
      'definition.initialStatusId missing',
      'definition.statuses list_length',
      'definition.extra unknown_key',
    ]);
    const bad = {
      initialStatusId: 1,
      statuses: [{ statusId: 1 }],
      transitions: [
        {
          id: 1,
          name: '  ',
          from: [],
          to: 0,
          event: 'Not-An-Event',
          guards: {
            all: [
              { type: 'teleport' },
              { type: 'compare-number', field: 'x', op: '~', value: '3' },
            ],
          },
          checks: [{ type: 'regex', field: 'summary', pattern: '', message: 'x'.repeat(501) }],
          effects: [{ type: 'webhook', url: 'ftp://example.test' }],
          triggers: [{ event: 'pull_request' }],
        },
      ],
      rules: { abc: [{ type: 'assign', to: { user: 7 } }] },
      statusPermissions: { '1': { edit: [{ role: '2' }, { team: '3' }] } },
    };
    expect(codes(bad)).toEqual([
      'definition.transitions[0].name text_length',
      'definition.transitions[0].from list_length',
      'definition.transitions[0].to not_id',
      'definition.transitions[0].event not_event',
      'definition.transitions[0].guards.all[0].type unknown_type',
      'definition.transitions[0].guards.all[1].op not_op',
      'definition.transitions[0].guards.all[1].value not_number',
      'definition.transitions[0].checks[0].pattern text_length',
      'definition.transitions[0].checks[0].message text_length',
      'definition.transitions[0].effects[0].url not_url',
      'definition.transitions[0].triggers[0].event not_trigger',
      'definition.rules.abc not_id_text',
      'definition.rules.abc[0].to.user not_id_text',
      'definition.statusPermissions["1"].edit[1].role missing',
      'definition.statusPermissions["1"].edit[1].team unknown_key',
    ]);
  });

  it('[WF-002] removing a status takes the transitions that need it and keeps the others', () => {
    const active = S.Active as number;
    const removal = statusRemoval(STEPPED_DEFINITION, active);
    expect(removal.removed.map((x) => x.name)).toEqual([
      'Start',
      'Send to review',
      'Back to active',
    ]);
    const support = statusRemoval(
      {
        ...STEPPED_DEFINITION,
        transitions: [
          { id: 9, name: 'Both', from: [active, S.New as number], to: S.Closed as number },
        ],
        rules: { '9': [{ type: 'assign', to: 'requester' }] },
      },
      active,
    );
    expect(support.trimmed.map((x) => x.id)).toEqual([9]);

    const next = removeStatus(
      {
        ...STEPPED_DEFINITION,
        rules: { '1': [{ type: 'assign', to: 'current-user' }] },
        statusPermissions: { [String(active)]: { edit: [{ role: '1' }] } },
      },
      active,
    );
    expect(next.statuses.map((s) => s.statusId)).not.toContain(active);
    expect(next.transitions.map((x) => x.name)).toEqual(['Close', 'Reopen']);
    expect(next.rules).toBeUndefined();
    expect(next.statusPermissions).toBeUndefined();
    // The initial status stays until another is chosen.
    expect(removeStatus(STEPPED_DEFINITION, S.New as number)).toBe(STEPPED_DEFINITION);
  });

  describe('a status added to a workflow that moves freely (WF-008)', () => {
    const COMPLETED = 7;

    it('[WF-008] can be entered at once, and only the closed stage sets Completed', () => {
      const added = addStatusFreely(
        FREE_DEFINITION,
        S.Approved as number,
        STATUSES,
        COMPLETED,
        [9],
      );
      expect(added.statuses.at(-1)).toEqual({ statusId: S.Approved });
      const into = added.transitions.at(-1);
      expect(into).toMatchObject({ id: 10, name: 'Approved', from: 'any', to: S.Approved });
      expect(into?.effects).toEqual([
        { type: 'update-system-field', field: 'close-reason', value: String(COMPLETED) },
      ]);
      expect(isFreeMoving(added)).toBe(true);
      const open = addStatusFreely(FREE_DEFINITION, S.Draft as number, STATUSES, COMPLETED);
      expect(open.transitions.at(-1)?.effects).toEqual([
        { type: 'clear-field', field: 'close-reason' },
      ]);
    });

    it('[WF-008] a closing status with no reason to set gets no transition, never one that clears', () => {
      const added = addStatusFreely(FREE_DEFINITION, S.Approved as number, STATUSES, null);
      expect(added.statuses.at(-1)).toEqual({ statusId: S.Approved });
      expect(added.transitions).toEqual(FREE_DEFINITION.transitions);
      const open = addStatusFreely(FREE_DEFINITION, S.Draft as number, STATUSES, null);
      expect(open.transitions.at(-1)?.effects).toEqual([
        { type: 'clear-field', field: 'close-reason' },
      ]);
    });

    it('[WF-008] says when an addition needs a close reason', () => {
      const needs = (definition: WorkflowDefinition, id: number | undefined) =>
        addingNeedsCloseReason(definition, id as number, STATUSES);
      expect(needs(FREE_DEFINITION, S.Approved)).toBe(true);
      expect(needs(FREE_DEFINITION, S.Draft)).toBe(false);
      expect(needs(STEPPED_DEFINITION, S.Approved)).toBe(false);
      // Already there: nothing is added.
      expect(needs(FREE_DEFINITION, S.Closed)).toBe(false);
      // A workflow with no transitions yet: the closing status it already had gets one too.
      const start: WorkflowDefinition = {
        initialStatusId: S.Closed as number,
        statuses: [{ statusId: S.Closed as number }],
        transitions: [],
      };
      expect(needs(start, S.Draft)).toBe(true);
    });

    it('[WF-008] a workflow with no transitions yet gets one into every status', () => {
      const start: WorkflowDefinition = {
        initialStatusId: S.New as number,
        statuses: [{ statusId: S.New as number }],
        transitions: [],
      };
      const added = addStatusFreely(start, S.Active as number, STATUSES, COMPLETED);
      expect(added.transitions.map((t) => [t.from, t.to])).toEqual([
        ['any', S.New],
        ['any', S.Active],
      ]);
    });

    it('[WF-008] a workflow with a rule keeps its steps as they are', () => {
      for (const ruled of [
        STEPPED_DEFINITION,
        withRules(FREE_DEFINITION, 1, [{ type: 'assign', to: 'requester' }]),
        updateTransition(FREE_DEFINITION, 1, (t) => ({ ...t, layout: ['close-reason'] })),
        updateTransition(FREE_DEFINITION, 1, (t) => ({
          ...t,
          checks: [{ type: 'field-required', field: 'assignee' }],
        })),
      ]) {
        expect(isFreeMoving(ruled)).toBe(false);
        const added = addStatusFreely(ruled, S.Approved as number, STATUSES, COMPLETED);
        expect(added.transitions).toEqual(ruled.transitions);
        expect(added.statuses.at(-1)).toEqual({ statusId: S.Approved });
      }
    });
  });

  describe('a draft that still has the first default steps (WF-008)', () => {
    const COMPLETED = 7;
    const clears = [{ type: 'clear-field', field: 'close-reason' }];

    it('[WF-008] finds the five seeded steps only as they were seeded', () => {
      expect(strictSeedSteps(STEPPED_DEFINITION)).toEqual({
        fresh: S.New,
        active: S.Active,
        review: S['In Review'],
        closed: S.Closed,
      });
      expect(strictSeedSteps(FREE_DEFINITION)).toBeNull();
      expect(strictSeedSteps(SUPPORT_DEFINITION)).toBeNull();
      // A step someone changed, removed or gave a rule is theirs.
      for (const changed of [
        updateTransition(STEPPED_DEFINITION, 1, (t) => ({ ...t, name: 'Begin' })),
        updateTransition(STEPPED_DEFINITION, 4, (t) => ({ ...t, checks: [] })),
        removeTransition(STEPPED_DEFINITION, 3),
        withRules(STEPPED_DEFINITION, 2, [{ type: 'assign', to: 'requester' }]),
        setInitialStatus(STEPPED_DEFINITION, S.Active as number),
      ]) {
        expect(strictSeedSteps(changed)).toBeNull();
      }
    });

    it('[WF-008] replaces them with free moves, numbered as before, and keeps the rest', () => {
      const freed = freeingSeed(STEPPED_DEFINITION, STATUSES, COMPLETED);
      expect(freed.transitions).toEqual(
        FREE_DEFINITION.transitions.map((t) =>
          t.to === S.Closed
            ? {
                ...t,
                effects: [
                  { type: 'update-system-field', field: 'close-reason', value: String(COMPLETED) },
                ],
              }
            : t,
        ),
      );
      expect(isFreeMoving(freed)).toBe(true);
      expect(strictSeedSteps(freed)).toBeNull();

      // A status the author added and drew a step to keeps that step; the seeded ones move freely.
      const drawn = addTransition(addStatus(STEPPED_DEFINITION, S.Draft as number), {
        id: 6,
        name: 'Park',
        from: [S.Active as number],
        to: S.Draft as number,
      });
      const kept = freeingSeed(drawn, STATUSES, COMPLETED);
      expect(kept.transitions.map((t) => t.id)).toEqual([5, 1, 2, 4, 6]);
      expect(kept.transitions.at(-1)).toEqual(drawn.transitions.at(-1));

      // One added with no way in gets its free move when everything else moves freely.
      const added = addStatus(STEPPED_DEFINITION, S.Approved as number);
      expect(freeingSeedNeedsCloseReason(added, STATUSES)).toBe(true);
      const reached = freeingSeed(added, STATUSES, COMPLETED, [8]);
      expect(reached.transitions.at(-1)).toMatchObject({
        id: 9,
        name: 'Approved',
        from: 'any',
        to: S.Approved,
      });
      expect(isFreeMoving(reached)).toBe(true);
    });

    it('[WF-008] a closing status with no reason to set keeps no free move', () => {
      const freed = freeingSeed(STEPPED_DEFINITION, STATUSES, null);
      expect(freed.transitions.map((t) => [t.id, t.effects])).toEqual([
        [5, clears],
        [1, clears],
        [2, clears],
      ]);
      expect(freeingSeedNeedsCloseReason(STEPPED_DEFINITION, STATUSES)).toBe(true);
      const open = STATUSES.map((s) =>
        s.id === S.Closed ? { ...s, stage: 'active' as const } : s,
      );
      expect(freeingSeedNeedsCloseReason(STEPPED_DEFINITION, open)).toBe(false);
      expect(freeingSeedNeedsCloseReason(FREE_DEFINITION, STATUSES)).toBe(false);
    });
  });

  it('[WF-002] edits change only what they name', () => {
    const added = addStatus(STEPPED_DEFINITION, S.Approved as number);
    expect(added.statuses.at(-1)).toEqual({ statusId: S.Approved });
    expect(addStatus(added, S.Approved as number)).toBe(added);
    expect(setInitialStatus(added, S.Approved as number).initialStatusId).toBe(S.Approved);
    const ruled = withRules(STEPPED_DEFINITION, 2, [{ type: 'assign', to: 'requester' }]);
    expect(ruled.rules).toEqual({ '2': [{ type: 'assign', to: 'requester' }] });
    expect(withRules(ruled, 2, [])).toEqual(STEPPED_DEFINITION);
    expect(removeTransition(ruled, 2).rules).toBeUndefined();
  });

  it('[WF-001] a new transition id is above every id the draft and its versions use', () => {
    const draft: WorkflowDefinition = { ...STEPPED_DEFINITION, transitions: [] };
    expect(nextTransitionId(draft)).toBe(1);
    expect(nextTransitionId(draft, transitionIdsOf(STEPPED_DEFINITION, null))).toBe(6);
  });

  it('compares definitions whatever their key order', () => {
    const a = { initialStatusId: 1, statuses: [{ statusId: 1 }], transitions: [] };
    const b = { transitions: [], statuses: [{ statusId: 1 }], initialStatusId: 1 };
    expect(sameDefinition(a, b)).toBe(true);
    expect(sameDefinition(a, { ...b, initialStatusId: 2 })).toBe(false);
  });
});

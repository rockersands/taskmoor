import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { richDefinitionArb, workflowArb } from '../test/workflow';
import {
  addStatus,
  formatDefinition,
  jsonErrorOffset,
  nextTransitionId,
  removeStatus,
  removeTransition,
  sameDefinition,
  setInitialStatus,
  statusRemoval,
  transitionIdsOf,
  type WorkflowDefinition,
  withRules,
} from './definition';
import { DEFAULT_DEFINITION, S, SUPPORT_DEFINITION } from './fixtures';
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
    expect(checkShape(DEFAULT_DEFINITION)).toEqual([]);
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
    const removal = statusRemoval(DEFAULT_DEFINITION, active);
    expect(removal.removed.map((x) => x.name)).toEqual([
      'Start',
      'Send to review',
      'Back to active',
    ]);
    const support = statusRemoval(
      {
        ...DEFAULT_DEFINITION,
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
        ...DEFAULT_DEFINITION,
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
    expect(removeStatus(DEFAULT_DEFINITION, S.New as number)).toBe(DEFAULT_DEFINITION);
  });

  it('[WF-002] edits change only what they name', () => {
    const added = addStatus(DEFAULT_DEFINITION, S.Approved as number);
    expect(added.statuses.at(-1)).toEqual({ statusId: S.Approved });
    expect(addStatus(added, S.Approved as number)).toBe(added);
    expect(setInitialStatus(added, S.Approved as number).initialStatusId).toBe(S.Approved);
    const ruled = withRules(DEFAULT_DEFINITION, 2, [{ type: 'assign', to: 'requester' }]);
    expect(ruled.rules).toEqual({ '2': [{ type: 'assign', to: 'requester' }] });
    expect(withRules(ruled, 2, [])).toEqual(DEFAULT_DEFINITION);
    expect(removeTransition(ruled, 2).rules).toBeUndefined();
  });

  it('[WF-001] a new transition id is above every id the draft and its versions use', () => {
    const draft: WorkflowDefinition = { ...DEFAULT_DEFINITION, transitions: [] };
    expect(nextTransitionId(draft)).toBe(1);
    expect(nextTransitionId(draft, transitionIdsOf(DEFAULT_DEFINITION, null))).toBe(6);
  });

  it('compares definitions whatever their key order', () => {
    const a = { initialStatusId: 1, statuses: [{ statusId: 1 }], transitions: [] };
    const b = { transitions: [], statuses: [{ statusId: 1 }], initialStatusId: 1 };
    expect(sameDefinition(a, b)).toBe(true);
    expect(sameDefinition(a, { ...b, initialStatusId: 2 })).toBe(false);
  });
});

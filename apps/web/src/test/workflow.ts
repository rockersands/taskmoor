import { fc } from '@taskmoor/testkit/property';
import { blankRule, CHECKS, EFFECTS, GUARDS, RULES } from '../workflow/catalogue';
import type {
  CheckDef,
  EffectDef,
  GuardNode,
  RuleDef,
  Stage,
  Transition,
  WorkflowDefinition,
} from '../workflow/definition';

/** Random workflow definitions for the editor's property tests (M1-030). */
const DEFAULTS = { status: '1', transition: '1', role: '1', group: '1' };
const leafTypes = Object.keys(GUARDS).filter((t) => t !== 'placeholder');

/** A guard leaf of any type, with its parameters at starting values. */
export const anyGuardLeaf = fc
  .constantFrom(...leafTypes)
  .map((type) => blankRule('guard', type, DEFAULTS) as GuardNode);

/** Guards whose satisfiability the lint can judge: always-false, number bounds, the rest. */
const judgedLeaf: fc.Arbitrary<GuardNode> = fc.oneof(
  fc.constant<GuardNode>({ type: 'always-false' }),
  fc.constant<GuardNode>({ type: 'only-assignee' }),
  fc.record({
    type: fc.constant('compare-number' as const),
    field: fc.constantFrom('original-estimate', 'time-spent'),
    op: fc.constantFrom(
      '=' as const,
      '!=' as const,
      '>' as const,
      '>=' as const,
      '<' as const,
      '<=' as const,
    ),
    value: fc.integer({ min: 0, max: 6 }),
  }),
);

export const guardTree = (leaf: fc.Arbitrary<GuardNode> = judgedLeaf): fc.Arbitrary<GuardNode> =>
  fc.letrec<{ node: GuardNode }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.record({ all: fc.array(tie('node'), { maxLength: 3 }) }),
      fc.record({ any: fc.array(tie('node'), { maxLength: 3 }) }),
    ),
  })).node;

export interface ArbitraryWorkflow {
  definition: WorkflowDefinition;
  stages: Map<number, Stage>;
}

/** A workflow of 1 to 8 statuses with random transitions, sources, globals and guards. */
export const workflowArb = (options: { guards?: boolean } = {}): fc.Arbitrary<ArbitraryWorkflow> =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 })
    .chain((ids) =>
      fc.record({
        ids: fc.constant(ids),
        initial: fc.constantFrom(...ids),
        stages: fc.array(fc.constantFrom<Stage>('new', 'active', 'closed'), {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        transitions: fc.array(
          fc.record({
            from: fc.oneof(
              { weight: 1, arbitrary: fc.constant<'any'>('any') },
              {
                weight: 4,
                arbitrary: fc.uniqueArray(fc.constantFrom(...ids), {
                  minLength: 1,
                  maxLength: ids.length,
                }),
              },
            ),
            to: fc.constantFrom(...ids),
            guards: options.guards
              ? fc.option(guardTree(), { nil: undefined, freq: 3 })
              : fc.constant(undefined),
          }),
          { maxLength: 14 },
        ),
      }),
    )
    .map(({ ids, initial, stages, transitions }) => ({
      definition: {
        initialStatusId: initial,
        statuses: ids.map((statusId) => ({ statusId })),
        transitions: transitions.map(
          (t, i): Transition => ({
            id: i + 1,
            name: `T${i + 1}`,
            from: t.from,
            to: t.to,
            ...(t.guards ? { guards: t.guards } : {}),
          }),
        ),
      },
      stages: new Map(ids.map((id, i) => [id, stages[i] ?? 'new'])),
    }));

/** A definition that uses every guard, check, effect and rule type, nested at random. */
export const richDefinitionArb: fc.Arbitrary<WorkflowDefinition> = fc
  .record({
    guards: fc.option(guardTree(anyGuardLeaf), { nil: undefined }),
    checks: fc.subarray(Object.keys(CHECKS)),
    effects: fc.subarray(Object.keys(EFFECTS)),
    rules: fc.subarray(Object.keys(RULES)),
    name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== ''),
    description: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
    properties: fc.option(
      fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ maxLength: 20 }), {
        maxKeys: 3,
      }),
      { nil: undefined },
    ),
    event: fc.option(fc.constantFrom('support-done', 'x', 'a1-b2'), { nil: undefined }),
    from: fc.constantFrom<'any' | number[]>('any', [1], [1, 2]),
  })
  .map((r) => {
    const transition: Transition = {
      id: 1,
      name: r.name,
      from: r.from,
      to: 2,
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.guards ? { guards: r.guards } : {}),
      ...(r.checks.length
        ? { checks: r.checks.map((type) => blankRule('check', type, DEFAULTS) as CheckDef) }
        : {}),
      ...(r.effects.length
        ? { effects: r.effects.map((type) => blankRule('effect', type, DEFAULTS) as EffectDef) }
        : {}),
      ...(r.properties ? { properties: r.properties } : {}),
      ...(r.event ? { event: r.event } : {}),
    };
    return {
      initialStatusId: 1,
      statuses: [{ statusId: 1 }, { statusId: 2, x: 10, y: 20 }],
      transitions: [transition],
      ...(r.rules.length
        ? { rules: { '1': r.rules.map((type) => blankRule('rule', type, DEFAULTS) as RuleDef) } }
        : {}),
    };
  });

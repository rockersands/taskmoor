import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { workflowArb } from '../test/workflow';
import type { Transition, WorkflowDefinition } from './definition';
import { layersOf, layoutDiagram, NODE_HEIGHT, NODE_WIDTH, TAB_WIDTH } from './diagram';
import { S, STEPPED_DEFINITION } from './fixtures';

const t = (id: number, from: Transition['from'], to: number): Transition => ({
  id,
  name: `T${id}`,
  from,
  to,
});

describe('workflow diagram layout (M1-030)', () => {
  it('[WF-002] lays statuses out in layers by their distance from the initial status', () => {
    const layers = layersOf(STEPPED_DEFINITION);
    expect(layers.get(S.New as number)).toBe(0);
    expect(layers.get(S.Active as number)).toBe(1);
    expect(layers.get(S['In Review'] as number)).toBe(2);
    // Closed is entered only by the global Close: it sits in the last layer.
    expect(layers.get(S.Closed as number)).toBe(3);
  });

  it('[WF-001] draws one labelled edge per transition, a tab for a global one, one line per source', () => {
    const definition: WorkflowDefinition = {
      initialStatusId: 1,
      statuses: [{ statusId: 1 }, { statusId: 2 }, { statusId: 3 }],
      transitions: [t(1, [1], 2), t(2, [1, 2], 3), t(3, 'any', 3), t(4, [2], 2), t(5, [3], 1)],
    };
    const diagram = layoutDiagram(definition);
    const byTransition = (id: number) => diagram.edges.filter((e) => e.transitionId === id);
    expect(byTransition(1).map((e) => e.kind)).toEqual(['forward']);
    expect(byTransition(2)).toHaveLength(2);
    expect(byTransition(2).filter((e) => e.label)).toHaveLength(1);
    expect(byTransition(3).map((e) => e.kind)).toEqual(['global']);
    expect(byTransition(4).map((e) => e.kind)).toEqual(['self']);
    expect(byTransition(5).map((e) => e.kind)).toEqual(['back']);
  });

  it('[WF-002] gives a lone global tab the free room around its box, so its name is not cut (AD-5)', () => {
    const definition: WorkflowDefinition = {
      initialStatusId: 1,
      statuses: [{ statusId: 1 }, { statusId: 2 }, { statusId: 3 }],
      transitions: [t(1, [1], 2), t(2, 'any', 2), t(3, 'any', 1), t(4, 'any', 3), t(5, 'any', 3)],
    };
    const diagram = layoutDiagram(definition);
    const tab = (id: number) => diagram.edges.find((e) => e.transitionId === id)?.label;
    const node = (id: number) => diagram.nodes.find((n) => n.statusId === id);
    // Alone on its status: wider than a shared tab, centred over the box.
    expect(tab(2)?.width).toBeGreaterThan(TAB_WIDTH);
    expect(tab(2)?.x).toBe((node(2)?.x ?? 0) + NODE_WIDTH / 2);
    // In the first column it stops at the drawing's left edge.
    expect((tab(3)?.x ?? 0) - (tab(3)?.width ?? 0) / 2).toBeGreaterThanOrEqual(0);
    // Two tabs on one status keep their shared width side by side.
    expect([tab(4)?.width, tab(5)?.width]).toEqual([TAB_WIDTH, TAB_WIDTH]);
  });

  it('[WF-012] marks statuses no path reaches', () => {
    const definition: WorkflowDefinition = {
      initialStatusId: 1,
      statuses: [{ statusId: 1 }, { statusId: 2 }, { statusId: 3 }],
      transitions: [t(1, [1], 2), t(2, [3], 1)],
    };
    const nodes = layoutDiagram(definition).nodes;
    expect(nodes.map((n) => [n.statusId, n.layer, n.reachable, n.initial])).toEqual([
      [1, 0, true, true],
      [2, 1, true, false],
      [3, 2, false, false],
    ]);
  });

  it('[WF-002] boxes never overlap, every transition is labelled once and the drawing fits its frame', () => {
    fc.assert(
      fc.property(workflowArb(), ({ definition }) => {
        const diagram = layoutDiagram(definition);
        expect(diagram.nodes).toHaveLength(definition.statuses.length);
        for (const [i, a] of diagram.nodes.entries()) {
          expect(a.x + NODE_WIDTH).toBeLessThanOrEqual(diagram.width);
          expect(a.y + NODE_HEIGHT).toBeLessThanOrEqual(diagram.height);
          for (const b of diagram.nodes.slice(i + 1)) {
            const apart =
              a.x + NODE_WIDTH <= b.x ||
              b.x + NODE_WIDTH <= a.x ||
              a.y + NODE_HEIGHT <= b.y ||
              b.y + NODE_HEIGHT <= a.y;
            expect(apart).toBe(true);
          }
        }
        for (const x of definition.transitions) {
          expect(diagram.edges.filter((e) => e.transitionId === x.id && e.label)).toHaveLength(1);
        }
        for (const e of diagram.edges) {
          for (const n of e.path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []) {
            expect(n).toBeGreaterThanOrEqual(0);
          }
          if (e.label) {
            expect(e.label.x + e.label.width / 2).toBeLessThanOrEqual(diagram.width);
            expect(e.label.y).toBeLessThanOrEqual(diagram.height);
          }
        }
      }),
    );
  });
});

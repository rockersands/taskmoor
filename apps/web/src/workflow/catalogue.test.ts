import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  blankRule,
  CHECKS,
  catalogueOf,
  EFFECTS,
  GUARDS,
  idsFromText,
  isWritableField,
  RULES,
  type RuleKind,
  SYSTEM_FIELDS,
  valueFromText,
  valueToText,
  WORKFLOW_FIELDS,
} from './catalogue';
import type { WorkflowDefinition } from './definition';
import { DEFINITION_PROBLEMS } from './describe';
import { checkShape } from './shape';

/** The server's source, from the repository root or from the app (as the SSO tests read it). */
const serverSource = (file: string) => {
  const path = [`apps/server/src/${file}`, `../server/src/${file}`]
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return readFileSync(path ?? file, 'utf8');
};

const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return text.slice(from, text.indexOf(end, from + start.length));
};

const typesIn = (block: string) =>
  [...block.matchAll(/type: z\.literal\('([a-z-]+)'\)/g)].map((m) => m[1]).sort();

/** A definition holding one rule of a kind, where the server's schema expects it. */
function holding(kind: RuleKind, rule: Record<string, unknown>): WorkflowDefinition {
  const transition = {
    id: 1,
    name: 'Go',
    from: [1],
    to: 1,
    ...(kind === 'guard' ? { guards: rule } : {}),
    ...(kind === 'check' ? { checks: [rule] } : {}),
    ...(kind === 'effect' ? { effects: [rule] } : {}),
  };
  return {
    initialStatusId: 1,
    statuses: [{ statusId: 1 }],
    transitions: [transition],
    ...(kind === 'rule' ? { rules: { '1': [rule] } } : {}),
  } as unknown as WorkflowDefinition;
}

describe('the rule catalogue of the workflow editor (M1-030)', () => {
  it('[WF-003] [WF-004] [WF-005] [WF-009] offers every guard, check, effect and rule type the server accepts', () => {
    const model = serverSource('workflows/model.ts');
    const sections: [RuleKind, string, string][] = [
      ['guard', 'const guardLeaf', ']);'],
      ['check', 'const checkDef', ']) as z.ZodType<CheckDef>'],
      ['effect', 'const effectDef', ']) as z.ZodType<EffectDef>'],
      ['rule', 'const ruleDef', ']) as z.ZodType<RuleDef>'],
    ];
    for (const [kind, start, end] of sections) {
      const server = typesIn(between(model, start, end));
      expect(server.length).toBeGreaterThan(5);
      expect(Object.keys(catalogueOf(kind)).sort()).toEqual(server);
    }
    const systemFields = between(model, 'const SYSTEM_FIELDS', '] as const');
    expect([...systemFields.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])).toEqual([...SYSTEM_FIELDS]);
  });

  it('[WF-006] knows the fields workflows read and which of them they may write', () => {
    const fields = between(serverSource('workflows/fields.ts'), 'WORKFLOW_FIELDS', '\n};');
    const entries = [...fields.matchAll(/^ {2}'?([a-z-]+)'?: \{/gm)];
    const server = entries.map((m, i) => {
      const body = fields.slice(m.index, entries[i + 1]?.index ?? fields.length);
      return { name: m[1] as string, writable: body.includes('parse') };
    });
    expect(server.map((f) => f.name)).toEqual([...WORKFLOW_FIELDS]);
    for (const f of server) expect(isWritableField(f.name)).toBe(f.writable);
  });

  it('[WF-002] words every problem the server reports about a definition', () => {
    const model = serverSource('workflows/model.ts');
    const codes = new Set([...model.matchAll(/problem: '([a-z_]+)'/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual(Object.keys(DEFINITION_PROBLEMS).sort());
  });

  it('[WF-003] [WF-004] [WF-005] [WF-009] a new rule of every type has the shape the server accepts', () => {
    const defaults = { status: '3', transition: '1', role: '2', group: '4' };
    for (const kind of ['guard', 'check', 'effect', 'rule'] as const) {
      for (const type of Object.keys(catalogueOf(kind))) {
        const rule = blankRule(kind, type, defaults);
        expect(checkShape(holding(kind, rule)), `${kind} ${type}`).toEqual([]);
      }
    }
    expect(Object.keys(GUARDS).length + Object.keys(CHECKS).length).toBe(28);
    expect(Object.keys(EFFECTS).length + Object.keys(RULES).length).toBe(17);
  });

  it('reads a typed value back as it was stored', () => {
    fc.assert(
      fc.property(
        fc.jsonValue().map((v) => JSON.parse(JSON.stringify(v)) as unknown),
        (value) => {
          expect(valueFromText(valueToText(value))).toEqual(value);
        },
      ),
    );
    expect(valueFromText('Waiting for parts')).toBe('Waiting for parts');
    expect(valueFromText('5')).toBe(5);
    expect(valueToText('5')).toBe('"5"');
    expect(idsFromText(' 3, 4 7,,')).toEqual(['3', '4', '7']);
  });
});

import type {
  Actor,
  Channel,
  HistoryEntry,
  ItemState,
  StatusPermissions,
  TransitionRequest,
  TransitionResult,
  WorkflowDef,
} from '../model';
import {
  type Assignment,
  type ConformanceCase,
  type ImportEntry,
  type ImportExpectation,
  type LintWarning,
  type PublishChange,
  type PublishExpectation,
  SECTIONS,
  type Section,
} from './case';

/**
 * What an implementation must offer to run the suite. Every method is optional: cases whose
 * method is missing count as unsupported, not failed, so an engine can grow into the suite.
 */
export interface WorkflowEngine {
  availableTransitions?(
    workflow: WorkflowDef,
    item: ItemState,
    actor: Actor,
    channel: Channel,
  ): string[];
  transition?(
    workflow: WorkflowDef,
    item: ItemState,
    actor: Actor,
    request: TransitionRequest,
  ): TransitionResult;
  create?(
    workflow: WorkflowDef,
    actor: Actor,
    fields: Record<string, unknown>,
  ): { item: ItemState; event: string; webhooks: string[] };
  checkPermission?(
    workflow: WorkflowDef,
    item: ItemState,
    actor: Actor,
    permission: keyof StatusPermissions,
  ): { allowed: boolean; reason?: string };
  boardMove?(
    workflow: WorkflowDef,
    item: ItemState,
    actor: Actor,
    column: string,
  ): { outcome: 'ok' | 'blocked'; item: ItemState };
  publish?(input: {
    draft: WorkflowDef;
    versions: WorkflowDef[];
    assignments: Assignment[];
    change: PublishChange;
    items: ItemState[];
    mapping: Record<string, string>;
    actor?: Actor;
  }): PublishExpectation;
  importFunctions?(entries: ImportEntry[]): ImportExpectation;
  exportImport?(workflow: WorkflowDef): WorkflowDef;
  lint?(workflow: WorkflowDef, boards: { id: string; columns: string[] }[]): LintWarning[];
}

export type CaseStatus = 'pass' | 'fail' | 'unsupported';

export interface CaseResult {
  id: string;
  section: Section;
  requirement: string;
  status: CaseStatus;
  detail?: string;
}

export interface SectionReport {
  section: Section;
  pass: number;
  fail: number;
  unsupported: number;
  total: number;
}

export interface ConformanceReport {
  results: CaseResult[];
  sections: SectionReport[];
  pass: number;
  fail: number;
  unsupported: number;
  total: number;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Subset match: every key of `expected` must match in `actual`, recursively; arrays must have
 * the same length and match element by element. Returns the path of the first difference.
 */
export function mismatch(actual: unknown, expected: unknown, path = ''): string | undefined {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path || '$'}: expected an array`;
    if (actual.length !== expected.length) {
      return `${path || '$'}: expected ${expected.length} entries, got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const m = mismatch(actual[i], expected[i], `${path}[${i}]`);
      if (m) return m;
    }
    return undefined;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return `${path || '$'}: expected an object`;
    }
    for (const [key, value] of Object.entries(expected)) {
      const m = mismatch(
        (actual as Record<string, unknown>)[key],
        value,
        path ? `${path}.${key}` : key,
      );
      if (m) return m;
    }
    return undefined;
  }
  if (actual !== expected) {
    return `${path || '$'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  return undefined;
}

function historyAdded(before: HistoryEntry[], after: HistoryEntry[]): HistoryEntry[] {
  return after.slice(before.length);
}

export function runCase(engine: WorkflowEngine, c: ConformanceCase): CaseResult {
  const base = { id: c.id, section: c.section, requirement: c.requirement };
  const unsupported = (what: string): CaseResult => ({
    ...base,
    status: 'unsupported',
    detail: `engine has no ${what}`,
  });
  const verdict = (m: string | undefined): CaseResult =>
    m ? { ...base, status: 'fail', detail: m } : { ...base, status: 'pass' };
  try {
    switch (c.kind) {
      case 'available': {
        if (!engine.availableTransitions) return unsupported('availableTransitions');
        const got = engine.availableTransitions(
          clone(c.workflow),
          clone(c.item),
          clone(c.actor),
          c.channel ?? 'ui',
        );
        return verdict(mismatch([...got].sort(), [...c.expect.transitions].sort(), 'transitions'));
      }
      case 'transition': {
        if (!engine.transition) return unsupported('transition');
        const before = clone(c.item);
        const result = engine.transition(clone(c.workflow), clone(c.item), clone(c.actor), {
          ...c.request,
        });
        if (c.expect.outcome === 'blocked') {
          if (result.outcome !== 'blocked') {
            return verdict(`outcome: expected "blocked", got "ok" (status ${result.item.status})`);
          }
          const m = mismatch(result, c.expect);
          if (m) return verdict(m);
          // A blocked transition changes nothing: no field, no history, no status (WF-004).
          // Both directions, because a subset match alone would miss an added key.
          return verdict(
            mismatch(result.item, before, 'item (must be unchanged)') ??
              mismatch(before, result.item, 'item (must be unchanged)'),
          );
        }
        if (result.outcome !== 'ok') {
          return verdict(
            `outcome: expected "ok", got "blocked" by ${result.by} ${result.name}${result.message ? ` (${result.message})` : ''}`,
          );
        }
        const { added, ...rest } = c.expect;
        const flat = {
          outcome: result.outcome,
          status: result.item.status,
          assignee: result.item.assignee,
          resolution: result.item.resolution,
          resolvedAt: result.item.resolvedAt,
          securityLevel: result.item.securityLevel,
          fields: result.item.fields,
          event: result.event,
          webhooks: result.webhooks,
          order: result.order,
          notificationsAfterSequence: result.notificationsAfterSequence,
        };
        const m = mismatch(flat, rest);
        if (m) return verdict(m);
        if (added) {
          return verdict(
            mismatch(historyAdded(before.history, result.item.history), added, 'added'),
          );
        }
        return verdict(undefined);
      }
      case 'create': {
        if (!engine.create) return unsupported('create');
        const made = engine.create(clone(c.workflow), clone(c.actor), clone(c.fields ?? {}));
        const { history, ...rest } = c.expect;
        const m = mismatch(
          { status: made.item.status, event: made.event, webhooks: made.webhooks },
          rest,
        );
        if (m) return verdict(m);
        return verdict(history ? mismatch(made.item.history, history, 'history') : undefined);
      }
      case 'permission': {
        if (!engine.checkPermission) return unsupported('checkPermission');
        const got = engine.checkPermission(
          clone(c.workflow),
          clone(c.item),
          clone(c.actor),
          c.permission,
        );
        return verdict(mismatch(got, c.expect));
      }
      case 'board-move': {
        if (!engine.boardMove) return unsupported('boardMove');
        const got = engine.boardMove(clone(c.workflow), clone(c.item), clone(c.actor), c.column);
        const { outcome, ...rest } = c.expect;
        const m = mismatch(got.outcome, outcome ?? 'ok', 'outcome');
        if (m) return verdict(m);
        return verdict(mismatch(got.item, rest, 'item'));
      }
      case 'publish': {
        if (!engine.publish) return unsupported('publish');
        const got = engine.publish({
          draft: clone(c.workflow),
          versions: clone(c.versions ?? []),
          assignments: clone(c.assignments ?? []),
          change: clone(c.change),
          items: clone(c.items ?? []),
          mapping: clone(c.mapping ?? {}),
          ...(c.actor ? { actor: clone(c.actor) } : {}),
        });
        return verdict(mismatch(got, c.expect));
      }
      case 'import': {
        if (!engine.importFunctions) return unsupported('importFunctions');
        return verdict(mismatch(engine.importFunctions(clone(c.entries)), c.expect));
      }
      case 'export-roundtrip': {
        if (!engine.exportImport) return unsupported('exportImport');
        const back = engine.exportImport(clone(c.workflow));
        return verdict(mismatch(back, c.workflow, 'workflow'));
      }
      case 'lint': {
        if (!engine.lint) return unsupported('lint');
        const got = engine.lint(clone(c.workflow), clone(c.boards ?? []));
        const key = (w: LintWarning) => `${w.kind}@${w.at}`;
        const sortBy = (ws: LintWarning[]) => [...ws].sort((a, b) => key(a).localeCompare(key(b)));
        return verdict(mismatch(sortBy(got), sortBy(c.expect.warnings), 'warnings'));
      }
    }
  } catch (error) {
    return {
      ...base,
      status: 'fail',
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function runConformance(
  engine: WorkflowEngine,
  cases: readonly ConformanceCase[],
): ConformanceReport {
  const results = cases.map((c) => runCase(engine, c));
  const sections = SECTIONS.map((section) => {
    const own = results.filter((r) => r.section === section);
    return {
      section,
      pass: own.filter((r) => r.status === 'pass').length,
      fail: own.filter((r) => r.status === 'fail').length,
      unsupported: own.filter((r) => r.status === 'unsupported').length,
      total: own.length,
    };
  }).filter((s) => s.total > 0);
  const count = (status: CaseStatus) => results.filter((r) => r.status === status).length;
  return {
    results,
    sections,
    pass: count('pass'),
    fail: count('fail'),
    unsupported: count('unsupported'),
    total: results.length,
  };
}

/** The per-section table the CLI prints, followed by every failure with its detail. */
export function formatReport(report: ConformanceReport): string {
  const width = Math.max(...report.sections.map((s) => s.section.length), 'section'.length);
  const lines = [
    `${'section'.padEnd(width)}  pass  fail  unsupported  total`,
    ...report.sections.map(
      (s) =>
        `${s.section.padEnd(width)}  ${String(s.pass).padStart(4)}  ${String(s.fail).padStart(4)}  ${String(s.unsupported).padStart(11)}  ${String(s.total).padStart(5)}`,
    ),
    `${'all'.padEnd(width)}  ${String(report.pass).padStart(4)}  ${String(report.fail).padStart(4)}  ${String(report.unsupported).padStart(11)}  ${String(report.total).padStart(5)}`,
  ];
  const failures = report.results.filter((r) => r.status === 'fail');
  if (failures.length > 0) {
    lines.push('', 'Failures:');
    for (const f of failures) lines.push(`- ${f.id}: ${f.detail ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

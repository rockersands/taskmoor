import type { Query } from '../ast';
import { type Catalogue, makeCatalogue } from '../fields';
import { QueryError } from '../lexer';
import { parseQuery } from '../parser';
import { printQuery } from '../print';
import { type Plan, type ResolveContext, resolveQuery } from '../resolve';
import { type QueryCase, SECTIONS, type Section } from './case';

/** What an implementation must offer. Every method is optional: missing ones count as unsupported. */
export interface QueryEngine {
  parse?(text: string): Query;
  print?(query: Query): string;
  resolve?(text: string, catalogue: Catalogue, ctx: ResolveContext): Plan;
}

/** The fixed clock and user the suite resolves against. */
export const CONTEXT: ResolveContext = { currentUserId: 7, now: new Date('2026-10-12T12:00:00Z') };

/** This package's own parser, printer and resolver. */
export const nativeEngine: QueryEngine = {
  parse: parseQuery,
  print: printQuery,
  resolve: (text, catalogue, ctx) => resolveQuery(parseQuery(text), catalogue, ctx),
};

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
  /** pass / total, in percent, rounded. */
  rate: number;
}

export interface ConformanceReport {
  results: CaseResult[];
  sections: SectionReport[];
  pass: number;
  fail: number;
  unsupported: number;
  total: number;
}

/** The tree without spans, for comparing shapes. */
export function stripSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSpans);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'span') out[k] = stripSpans(v);
    return out;
  }
  return value;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(stripSpans(a)) === JSON.stringify(stripSpans(b));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runCase(engine: QueryEngine, c: QueryCase): CaseResult {
  const base = { id: c.id, section: c.section, requirement: c.requirement };
  const unsupported = (what: string): CaseResult => ({
    ...base,
    status: 'unsupported',
    detail: `engine has no ${what}`,
  });
  const pass: CaseResult = { ...base, status: 'pass' };
  const fail = (detail: string): CaseResult => ({ ...base, status: 'fail', detail });
  try {
    switch (c.kind) {
      case 'parse': {
        if (!engine.parse || !engine.print) return unsupported('parse and print');
        const tree = engine.parse(c.text);
        const printed = engine.print(tree);
        if (printed !== c.expect.canonical) {
          return fail(
            `printed ${JSON.stringify(printed)}, expected ${JSON.stringify(c.expect.canonical)}`,
          );
        }
        const again = engine.parse(printed);
        if (!same(again, tree)) return fail('the canonical form parses to a different tree');
        return pass;
      }
      case 'parse-error': {
        if (!engine.parse) return unsupported('parse');
        try {
          engine.parse(c.text);
        } catch (error) {
          if (!(error instanceof QueryError)) return fail(`threw ${describeError(error)}`);
          if (error.position !== c.expect.at) {
            return fail(`error at ${error.position}, expected ${c.expect.at}: ${error.message}`);
          }
          if (
            c.expect.message &&
            !error.message.toLowerCase().includes(c.expect.message.toLowerCase())
          ) {
            return fail(
              `message ${JSON.stringify(error.message)} lacks ${JSON.stringify(c.expect.message)}`,
            );
          }
          return pass;
        }
        return fail('parsed without error');
      }
      case 'resolve': {
        if (!engine.resolve) return unsupported('resolve');
        const catalogue = c.catalogue ?? makeCatalogue();
        try {
          engine.resolve(c.text, catalogue, CONTEXT);
        } catch (error) {
          if (c.expect.ok) return fail(`refused: ${describeError(error)}`);
          const message = describeError(error);
          return message.toLowerCase().includes(c.expect.message.toLowerCase())
            ? pass
            : fail(
                `refused with ${JSON.stringify(message)}, expected ${JSON.stringify(c.expect.message)}`,
              );
        }
        return c.expect.ok
          ? pass
          : fail(`accepted; expected a refusal mentioning ${JSON.stringify(c.expect.message)}`);
      }
      case 'equivalent': {
        if (!engine.resolve) return unsupported('resolve');
        const catalogue = c.catalogue ?? makeCatalogue();
        const plans = c.texts.map((t) => JSON.stringify(engine.resolve?.(t, catalogue, CONTEXT)));
        const first = plans[0];
        const odd = plans.findIndex((p) => p !== first);
        return odd === -1
          ? pass
          : fail(
              `${JSON.stringify(c.texts[odd])} resolves differently from ${JSON.stringify(c.texts[0])}`,
            );
      }
    }
  } catch (error) {
    return fail(`threw: ${describeError(error)}`);
  }
}

export function runConformance(
  engine: QueryEngine,
  cases: readonly QueryCase[],
): ConformanceReport {
  const results = cases.map((c) => runCase(engine, c));
  const sections = SECTIONS.map((section) => {
    const own = results.filter((r) => r.section === section);
    const pass = own.filter((r) => r.status === 'pass').length;
    return {
      section,
      pass,
      fail: own.filter((r) => r.status === 'fail').length,
      unsupported: own.filter((r) => r.status === 'unsupported').length,
      total: own.length,
      rate: own.length === 0 ? 0 : Math.round((100 * pass) / own.length),
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

/** The per-section table with pass rates, then the failures grouped by section. */
export function formatReport(report: ConformanceReport, { failures = 20 } = {}): string {
  const width = Math.max(...report.sections.map((s) => s.section.length), 'section'.length);
  const lines = [
    `${'section'.padEnd(width)}  pass  fail  unsupported  total   rate`,
    ...report.sections.map(
      (s) =>
        `${s.section.padEnd(width)}  ${String(s.pass).padStart(4)}  ${String(s.fail).padStart(4)}  ${String(s.unsupported).padStart(11)}  ${String(s.total).padStart(5)}  ${String(s.rate).padStart(4)}%`,
    ),
    `${'all'.padEnd(width)}  ${String(report.pass).padStart(4)}  ${String(report.fail).padStart(4)}  ${String(report.unsupported).padStart(11)}  ${String(report.total).padStart(5)}  ${String(report.total === 0 ? 0 : Math.round((100 * report.pass) / report.total)).padStart(4)}%`,
  ];
  const failed = report.results.filter((r) => r.status === 'fail');
  if (failed.length > 0) {
    lines.push('', `Failures (first ${Math.min(failures, failed.length)} of ${failed.length}):`);
    for (const f of failed.slice(0, failures)) lines.push(`- ${f.id}: ${f.detail ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

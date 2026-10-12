import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadRequirements, type Requirement } from './specs';

/** A test cites a requirement by putting its ID in brackets in the test name: `[CORE-028]`. */
const CITATION = /\[([A-Z]{2,5}-\d{3})\]/g;
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const SKIP = new Set(['node_modules', '.tsbuild', 'dist', '__golden__']);

export interface Citation {
  id: string;
  file: string;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

export function findCitations(root: string, folders = ['apps', 'packages']): Citation[] {
  const citations: Citation[] = [];
  for (const folder of folders) {
    for (const path of testFiles(join(root, folder))) {
      const file = relative(root, path).replaceAll('\\', '/');
      for (const match of readFileSync(path, 'utf8').matchAll(CITATION)) {
        if (match[1]) citations.push({ id: match[1], file });
      }
    }
  }
  return citations;
}

export interface TraceReport {
  unknown: Citation[];
  byMilestone: { milestone: string; covered: number; total: number }[];
  covered: Set<string>;
}

export function trace(
  requirements: readonly Requirement[],
  citations: readonly Citation[],
): TraceReport {
  const known = new Set(requirements.map((r) => r.id));
  const covered = new Set(citations.filter((c) => known.has(c.id)).map((c) => c.id));
  const milestones = [...new Set(requirements.map((r) => r.milestone))].sort();
  return {
    unknown: citations.filter((c) => !known.has(c.id)),
    covered,
    byMilestone: milestones.map((milestone) => {
      const inMilestone = requirements.filter((r) => r.milestone === milestone);
      return {
        milestone,
        covered: inMilestone.filter((r) => covered.has(r.id)).length,
        total: inMilestone.length,
      };
    }),
  };
}

export function formatTrace(report: TraceReport): string {
  const lines = report.byMilestone.map(({ milestone, covered, total }) => {
    const pct = total === 0 ? 0 : Math.round((covered / total) * 100);
    return `${milestone}: ${covered}/${total} requirements cited by tests (${pct}%)`;
  });
  for (const c of report.unknown) lines.push(`Unknown requirement ${c.id} cited in ${c.file}`);
  return lines.join('\n');
}

export function traceRepository(root: string): TraceReport {
  return trace(loadRequirements(root), findCitations(root));
}

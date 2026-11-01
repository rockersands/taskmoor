import {
  bagOfWordsEmbed,
  type DuplicateReport,
  type Embed,
  type Rerank,
  runDuplicateEval,
} from './duplicates-eval';
import { QUERY_PAIRS } from './query-corpus';
import {
  type QueryCandidate,
  type QueryReport,
  referenceCandidate,
  runQueryEval,
  textSearchBaseline,
} from './query-eval';
import type { EvalWorld } from './seed';
import {
  firstCommentBaseline,
  runSummaryEval,
  type SummaryCandidate,
  type SummaryReport,
} from './summary-eval';

/**
 * The eval runner (M1-133; ADR-107): a score per feature for a candidate implementation, or,
 * with none, the runs that prove the runner itself: the references (query: 100%), a weak
 * baseline per feature, and the summary grader's agreement with its graded examples.
 */
export type Feature = 'query' | 'summary' | 'duplicates';
export const FEATURES: readonly Feature[] = ['query', 'summary', 'duplicates'];

/** What `--candidate <module>` exports (default or `candidate`): any of the three features. */
export interface EvalCandidate {
  name: string;
  query?: QueryCandidate;
  summary?: SummaryCandidate;
  embed?: Embed;
  rerank?: Rerank;
}

/**
 * The thresholds M1-079 must meet on this corpus: exact-result match for natural language to
 * query; every summary passing the automatic criteria (the judged ones once a model runs them);
 * recall@3 for duplicates (proposed in ADR-107).
 */
export const THRESHOLDS = { query: 0.85, summary: 1, duplicates: 0.8 } as const;

export interface EvalRun {
  query: QueryReport[];
  summary: SummaryReport[];
  duplicates: DuplicateReport[];
  /** Results that wait for something this branch lacks. */
  pending: string[];
  /** The proof runs that failed: the runner is broken when this is not empty. */
  broken: string[];
}

export async function runEvals(options: {
  features: readonly Feature[];
  candidate?: EvalCandidate;
  /** The seeded dataset, made on first use (query and summary need it). */
  world: () => Promise<EvalWorld>;
}): Promise<EvalRun> {
  const { candidate } = options;
  const run: EvalRun = { query: [], summary: [], duplicates: [], pending: [], broken: [] };
  if (options.features.includes('query')) {
    const world = await options.world();
    if (candidate?.query) {
      run.query.push(await runQueryEval(world, candidate.query, candidate.name));
    } else {
      const reference = await runQueryEval(
        world,
        referenceCandidate(QUERY_PAIRS),
        'reference queries',
      );
      if (reference.score !== 1)
        run.broken.push(`query references score ${reference.score}, not 1`);
      run.query.push(reference);
      run.query.push(
        await runQueryEval(world, textSearchBaseline, 'baseline: the prompt as a text search'),
      );
    }
  }
  if (options.features.includes('summary')) {
    const world = await options.world();
    const summarise = candidate?.summary;
    const report = summarise
      ? await runSummaryEval(world, summarise, candidate.name)
      : await runSummaryEval(
          world,
          firstCommentBaseline,
          'baseline: summary, status and first comment',
        );
    if (report.grader.score !== 1) {
      run.broken.push(
        `the summary grader disagrees with ${report.grader.disagreements.length} graded examples`,
      );
    }
    run.summary.push(report);
    run.pending.push('summary: the judged criteria (judge-prompt.md) wait for a model (M1-079)');
  }
  if (options.features.includes('duplicates')) {
    if (candidate?.embed) {
      run.duplicates.push(
        await runDuplicateEval(
          candidate.embed,
          candidate.name,
          candidate.rerank ? { rerank: candidate.rerank } : {},
        ),
      );
    } else {
      run.duplicates.push(await runDuplicateEval(bagOfWordsEmbed, 'stand-in: bag of words'));
      run.pending.push('duplicates: the bundled model’s score waits for its runtime (M1-078)');
    }
  }
  return run;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The run as text: one line per report, then its failures (up to `failures` each). */
export function formatRun(run: EvalRun, failures = 10, candidate?: string): string {
  const out: string[] = [];
  const meets = (score: number, threshold: number) =>
    candidate ? `  ${score >= threshold ? 'meets' : 'below'} M1-079's ${pct(threshold)}` : '';
  for (const r of run.query) {
    const langs = Object.entries(r.byLanguage)
      .map(([l, s]) => `${l} ${s.passed}/${s.total}`)
      .join(', ');
    out.push(
      `query       ${r.candidate}: ${r.passed}/${r.total} exact-result match, ${pct(r.score)} (${langs})${meets(r.score, THRESHOLDS.query)}`,
    );
    for (const f of r.failures.slice(0, failures)) {
      out.push(`  ${f.id} "${f.prompt}" -> ${f.query}: ${f.problem}`);
    }
    if (r.failures.length > failures) out.push(`  ... and ${r.failures.length - failures} more`);
  }
  for (const r of run.summary) {
    out.push(
      `summary     grader self-check: ${r.grader.agree}/${r.grader.examples} graded examples agree, ${pct(r.grader.score)}`,
    );
    for (const d of r.grader.disagreements.slice(0, failures)) {
      out.push(
        `  ${d.example}: labelled ${d.expected} [${d.labelled.join(', ')}], graded ${d.got} [${d.found.join(', ')}]`,
      );
    }
    out.push(
      `summary     ${r.candidate}: ${r.passed}/${r.total} pass the automatic criteria, ${pct(r.score)}${meets(r.score, THRESHOLDS.summary)}`,
    );
    for (const f of r.failures.slice(0, failures)) out.push(`  ${f.id}: ${f.details.join('; ')}`);
    if (r.failures.length > failures) out.push(`  ... and ${r.failures.length - failures} more`);
  }
  for (const r of run.duplicates) {
    out.push(
      `duplicates  ${r.candidate}: recall@3 ${pct(r.recallAt3)} over ${r.queries} queries (pool ${r.pool}), MRR ${r.mrr.toFixed(3)}, near miss above the duplicate ${pct(r.nearMissAbove)}${meets(r.recallAt3, THRESHOLDS.duplicates)}`,
    );
    for (const f of r.failures.slice(0, failures))
      out.push(`  ${f.id}: first duplicate at ${f.rank}, top 3 ${f.top.join(', ')}`);
    if (r.failures.length > failures) out.push(`  ... and ${r.failures.length - failures} more`);
  }
  for (const p of run.pending) out.push(`pending     ${p}`);
  for (const b of run.broken) out.push(`BROKEN      ${b}`);
  return `${out.join('\n')}\n`;
}

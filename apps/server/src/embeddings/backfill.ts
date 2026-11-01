import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { EmbeddingService } from './service';
import type { VectorStatus } from './vector';

export interface BackfillReport {
  workspace: string;
  model: string;
  search: VectorStatus['search'];
  tickets: number;
  comments: number;
  removed: number;
  cleared: number;
  ms: number;
  coverage: { tickets: number; ticketVectors: number; comments: number; commentVectors: number };
}

/**
 * The operator's backfill (`node cli.mjs embeddings [--rebuild]`, M1-078; ADR-106): sets
 * pgvector up where the database offers it, then embeds every stale ticket and comment of each
 * workspace in this process, until none is left. `rebuild` first drops every vector, for a
 * changed model or a suspect index. The worker does the same in the background on its own;
 * this is for doing it now, with progress.
 */
export async function backfillEmbeddings(
  db: Kysely<Database>,
  service: EmbeddingService,
  options: { rebuild?: boolean; progress?: (line: string) => void } = {},
): Promise<BackfillReport[]> {
  const status = await service.prepare();
  const workspaces = await db.selectFrom('workspace').select(['id', 'key']).orderBy('id').execute();
  const reports: BackfillReport[] = [];
  for (const workspace of workspaces) {
    const started = Date.now();
    const cleared = options.rebuild ? await service.indexer.clear(workspace.id) : 0;
    let cursor = { ticket: 0, comment: 0 };
    const total = { tickets: 0, comments: 0, removed: 0 };
    for (;;) {
      const run = await service.indexer.sweep(workspace.id, cursor, 10_000);
      total.tickets += run.tickets;
      total.comments += run.comments;
      total.removed += run.removed;
      if (!run.next) break;
      cursor = run.next;
      options.progress?.(
        `${workspace.key}: ${total.tickets} ticket(s) and ${total.comments} comment(s) embedded so far`,
      );
    }
    reports.push({
      workspace: workspace.key,
      model: service.model,
      search: status.search,
      ...total,
      cleared,
      ms: Date.now() - started,
      coverage: await service.indexer.coverage(workspace.id),
    });
  }
  return reports;
}

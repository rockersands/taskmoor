import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { Subscriber } from '../events/bus';
import type { EventType } from '../events/catalogue';
import { enqueue, type JobRunner } from '../events/queue';
import type { EmbeddingIndexer, SweepCursor } from './indexer';

/**
 * Embeddings in the background (M1-078; ADR-106): the event subscriber embeds what a change
 * names, right after it commits; the sweep job catches up with everything else, a few seconds
 * at a time so other jobs keep their turn (the job runner runs one job at a time).
 */
export const EMBEDDING_SUBSCRIBER = 'embeddings';
export const SWEEP_TASK = 'embeddings:sweep';

const EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.cloned',
  'ticket.deleted',
  'ticket.restored',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'import_run.finished',
] as const satisfies readonly EventType[];

export function embeddingSubscriber(db: Kysely<Database>, indexer: EmbeddingIndexer): Subscriber {
  return {
    name: EMBEDDING_SUBSCRIBER,
    types: EVENTS,
    async handle(event) {
      const ws = event.workspaceId;
      const id = Number(event.subjectId);
      const payload = event.payload as {
        subtickets?: number[];
        dryRun?: boolean;
      };
      switch (event.type) {
        case 'ticket.created':
        case 'ticket.updated':
        case 'ticket.cloned':
          await indexer.refreshTickets(ws, [id]);
          return;
        case 'ticket.deleted':
          await indexer.dropTrashed(ws, [id, ...(payload.subtickets ?? [])]);
          return;
        case 'ticket.restored': {
          const ids = [id, ...(payload.subtickets ?? [])];
          await indexer.refreshTickets(ws, ids);
          await indexer.refreshComments(ws, await indexer.commentIdsOf(ws, ids));
          return;
        }
        case 'comment.created':
        case 'comment.updated':
        case 'comment.deleted':
          await indexer.refreshComments(ws, [id]);
          return;
        case 'import_run.finished':
          // Imports write tickets and comments without events of their own.
          if (!payload.dryRun) await scheduleEmbeddingSweep(db, ws, `import:${id}`);
          return;
      }
    },
  };
}

/**
 * Queues a sweep of the workspace, once per `reason` ever: `boot:<model>` when a worker first
 * runs with a model, `import:<run>` after an import, `rebuild:<time>` from the CLI.
 */
export async function scheduleEmbeddingSweep(
  db: Kysely<Database>,
  workspaceId: number,
  reason: string,
): Promise<boolean> {
  const added = await enqueue(db, [
    {
      workspaceId,
      task: SWEEP_TASK,
      payload: { run: reason, cursor: { ticket: 0, comment: 0 } },
      key: `${SWEEP_TASK}:${workspaceId}:${reason}:0:0`,
    },
  ]);
  return added > 0;
}

/** Each workspace's first sweep with this model, so an upgrade embeds what was there before. */
export async function scheduleBootSweeps(db: Kysely<Database>, model: string): Promise<number> {
  const workspaces = await db.selectFrom('workspace').select('id').execute();
  let added = 0;
  for (const w of workspaces) {
    if (await scheduleEmbeddingSweep(db, w.id, `boot:${model}`)) added++;
  }
  return added;
}

export function registerEmbeddingJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  indexer: EmbeddingIndexer,
  options: { budgetMs?: number; log?: (message: string, details: object) => void } = {},
): void {
  runner.handle(SWEEP_TASK, async (job) => {
    const { run, cursor } = job.payload as { run: string; cursor: SweepCursor };
    const result = await indexer.sweep(job.workspaceId, cursor, options.budgetMs ?? 5_000);
    if (result.tickets + result.comments + result.removed > 0) {
      options.log?.('embeddings swept', { run, ...result });
    }
    if (result.next) {
      await enqueue(db, [
        {
          workspaceId: job.workspaceId,
          task: SWEEP_TASK,
          payload: { run, cursor: result.next },
          key: `${SWEEP_TASK}:${job.workspaceId}:${run}:${result.next.ticket}:${result.next.comment}`,
        },
      ]);
    }
  });
}

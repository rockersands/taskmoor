import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

export interface WaitOptions {
  /** Give up after this long; the process then exits and the supervisor restarts it. */
  timeoutMs?: number;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Waits for the database to answer before migrations run. In a Compose kit Postgres starts at
 * the same time as the backend and needs a few seconds; exiting at once would make the first
 * start fail on every fresh install (OPS-001).
 */
export async function waitForDatabase(
  db: Kysely<Database>,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  for (;;) {
    try {
      await sql`SELECT 1`.execute(db);
      return;
    } catch (error) {
      if (Date.now() + intervalMs > deadline) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Database did not answer within ${Math.round(timeoutMs / 1000)}s: ${detail}`,
        );
      }
      if (!warned) {
        options.log?.('waiting for the database');
        warned = true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

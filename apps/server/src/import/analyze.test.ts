import { useMigratedDatabase } from '@taskmoor/db/testing';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { analyzeImported } from './run';

describe('statistics after an import (M1-117)', () => {
  const database = useMigratedDatabase();

  it('[IMP-003] [NFR-001] analyzes every table an import fills', async () => {
    await analyzeImported(database.db);
    const { rows } = await sql<{ relname: string; analyzed: boolean }>`
      SELECT relname, (last_analyze IS NOT NULL) AS analyzed
        FROM pg_stat_user_tables
       WHERE relname IN ('ticket', 'ticket_comment', 'ticket_link',
                         'ticket_web_link', 'ticket_follower', 'ticket_vote',
                         'ticket_key_history', 'time_entry', 'v_text',
                         'v_number', 'v_date', 'v_time', 'v_user', 'v_option')`.execute(
      database.db,
    );
    expect(rows).toHaveLength(14);
    expect(rows.filter((r) => !r.analyzed).map((r) => r.relname)).toEqual([]);
    // History is partitioned by ticket: the statistics live on its partitions.
    const parts = await sql<{ analyzed: boolean }>`
      SELECT (s.last_analyze IS NOT NULL) AS analyzed
        FROM pg_inherits i JOIN pg_stat_user_tables s ON s.relid = i.inhrelid
       WHERE i.inhparent = 'ticket_change'::regclass`.execute(database.db);
    expect(parts.rows.length).toBeGreaterThan(0);
    expect(parts.rows.every((r) => r.analyzed)).toBe(true);
  });
});

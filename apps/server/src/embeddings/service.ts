import { type Embedder, EndpointEmbedder, LocalEmbedder } from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { EmbeddingIndexer } from './indexer';
import { decodeRealArray, type SimilarHit, type SimilarQuery, similarTickets } from './similar';
import { ensureVectorIndex, type VectorSearch, type VectorStatus, vectorStatus } from './vector';

/**
 * Embeddings for one process (M1-078; AI-012; NFR-011; ADR-106): the embedder (the bundled
 * local model unless an external endpoint is configured), the indexer and similar-ticket
 * lookups. They do not depend on the workspace's AI switch or a provider key: the local model
 * sends nothing anywhere, so similar tickets and duplicate suggestions work on an install that
 * never set AI up. Operators turn them off with `TASKMOOR_EMBEDDINGS=off`.
 */
export type EmbeddingsSetting =
  | { mode: 'local' }
  | { mode: 'off' }
  | { mode: 'endpoint'; url: string; model: string; apiKey?: string; dimensions?: number };

export interface EmbeddingServiceOptions {
  /** `exact` forces the scan without pgvector (tests, or a server whose index misbehaves). */
  search?: VectorSearch;
}

let shared: LocalEmbedder | undefined;

/** One bundled model per process: its thread and 23 MB of weights are loaded once. */
export function sharedLocalEmbedder(): LocalEmbedder {
  shared ??= new LocalEmbedder();
  return shared;
}

export function embedderFor(setting: EmbeddingsSetting): Embedder | null {
  if (setting.mode === 'off') return null;
  if (setting.mode === 'endpoint') {
    return new EndpointEmbedder({
      baseUrl: setting.url,
      model: setting.model,
      ...(setting.apiKey ? { apiKey: setting.apiKey } : {}),
      ...(setting.dimensions ? { dimensions: setting.dimensions } : {}),
    });
  }
  return sharedLocalEmbedder();
}

export class EmbeddingService {
  readonly indexer: EmbeddingIndexer;
  private status: { at: number; value: Promise<VectorStatus> } | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    readonly embedder: Embedder,
    private readonly options: EmbeddingServiceOptions = {},
  ) {
    this.indexer = new EmbeddingIndexer(db, embedder);
  }

  get model(): string {
    return this.embedder.model;
  }

  /** Sets pgvector and its index up where possible (at start); says how lookups will run. */
  async prepare(): Promise<VectorStatus> {
    const status =
      this.options.search === 'exact'
        ? { search: 'exact' as const, version: null, reason: 'exact search was asked for' }
        : await ensureVectorIndex(this.db, this.embedder.dimensions);
    this.status = { at: Date.now(), value: Promise.resolve(status) };
    return status;
  }

  /**
   * How lookups run, read from the database at most once a minute: another process (the
   * worker) may install pgvector after this one started.
   */
  vectorSearch(): Promise<VectorStatus> {
    if (this.options.search === 'exact') {
      return Promise.resolve({
        search: 'exact',
        version: null,
        reason: 'exact search was asked for',
      });
    }
    if (!this.status || Date.now() - this.status.at > 60_000) {
      const value = vectorStatus(this.db);
      this.status = { at: Date.now(), value };
      value.catch(() => {
        this.status = undefined;
      });
    }
    return this.status.value;
  }

  async embedText(text: string): Promise<Float32Array> {
    const [vector] = await this.embedder.embed([text]);
    if (!vector) throw new Error('the embedder returned no vector');
    return vector;
  }

  /**
   * The vector a ticket is looked up by: its stored one while current, else made from its
   * text now (the indexer may not have reached it yet).
   */
  async ticketVector(workspaceId: number, ticketId: number): Promise<Float32Array | null> {
    const { rows } = await sql<{ text: string; hash: string; bin: Buffer | null; n: number }>`
      SELECT s.text, md5(s.text) AS hash,
             CASE WHEN e.model = ${this.model} AND e.source_hash = md5(s.text)
                  THEN array_send(e.embedding) END AS bin,
             cardinality(e.embedding) AS n
        FROM ticket k
        CROSS JOIN LATERAL (SELECT taskmoor_embedding_text(k.summary, k.description) AS text) s
        LEFT JOIN ticket_embedding e ON e.ticket_id = k.id
       WHERE k.workspace_id = ${workspaceId} AND k.id = ${ticketId}`.execute(this.db);
    const row = rows[0];
    if (!row) return null;
    if (row.bin) return decodeRealArray(row.bin, row.n);
    return row.text.trim() === '' ? null : this.embedText(row.text);
  }

  async similar(query: Omit<SimilarQuery, 'model'>): Promise<SimilarHit[]> {
    const status = await this.vectorSearch();
    return similarTickets(
      this.db,
      { ...query, model: this.model },
      { mode: status.search, version: status.version },
    );
  }
}

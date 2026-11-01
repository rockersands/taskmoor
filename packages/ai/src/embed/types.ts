/**
 * Text embeddings (M1-078, AI-012; ADR-106): one interface over the bundled local model and an
 * optional external endpoint. A vector is unit length, so the dot product of two is their
 * cosine similarity.
 */
export interface Embedder {
  /**
   * What made the vectors, stored next to each one: a vector of another model is stale and is
   * computed again. `local:all-MiniLM-L6-v2` for the bundled model.
   */
  readonly model: string;
  readonly dimensions: number;
  /** One unit vector per text, in order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** Releases the runtime (worker threads, sockets). */
  close(): Promise<void>;
}

/** The dot product: the cosine similarity of two unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** Scales a vector to unit length in place; a zero vector stays zero. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] as number) ** 2;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

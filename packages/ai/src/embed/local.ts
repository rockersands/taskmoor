import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Embedder } from './types';
import { WordPieceTokenizer } from './wordpiece';

/**
 * The bundled embedding model (M1-078, AI-012; ADR-106): all-MiniLM-L6-v2 in int8 ONNX, run by
 * ONNX Runtime's WebAssembly build on a worker thread of this process, so the event loop stays
 * free while it computes (NFR-012). WebAssembly needs no native binary: the same files run on
 * the Alpine image for amd64 and arm64, and nothing is fetched, as the model and the runtime's
 * two files ship with the server.
 *
 * Tokens are made here (`WordPieceTokenizer`); the thread runs the model and pools as the model
 * was trained: the mean of the token vectors under the attention mask, scaled to unit length.
 */
export const LOCAL_MODEL_NAME = 'all-MiniLM-L6-v2';
export const LOCAL_MODEL_ID = `local:${LOCAL_MODEL_NAME}`;
export const LOCAL_DIMENSIONS = 384;
/** The longest input the model was trained on, in tokens with `[CLS]` and `[SEP]`. */
export const LOCAL_MAX_TOKENS = 256;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Where the model's files are: `TASKMOOR_MODELS_DIR`, next to the bundled server
 * (`dist/models`), or the package's own `models` folder when running from source.
 */
export function bundledModelDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    ...(env.TASKMOOR_MODELS_DIR ? [join(env.TASKMOOR_MODELS_DIR, LOCAL_MODEL_NAME)] : []),
    here(`./models/${LOCAL_MODEL_NAME}`),
    here(`../../models/${LOCAL_MODEL_NAME}`),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, 'model_qint8.onnx')));
  if (!found)
    throw new Error(`the embedding model is missing (looked in ${candidates.join(', ')})`);
  return found;
}

/** The runtime's WebAssembly files next to the bundled server; from source the package has them. */
function bundledRuntimeDir(): string | undefined {
  const dir = here('./ort/');
  return existsSync(join(dir, 'ort-wasm-simd-threaded.wasm')) ? dir : undefined;
}

/** The inference thread's script: bundled next to the server, or this folder's source. */
function workerFile(): URL {
  const bundled = new URL('./embed-worker.mjs', import.meta.url);
  return existsSync(fileURLToPath(bundled))
    ? bundled
    : new URL('./ort-worker.mjs', import.meta.url);
}

export interface LocalEmbedderOptions {
  modelDir?: string;
  /** WebAssembly threads inside the inference thread; 1 (the default) adds none. */
  threads?: number;
  /**
   * Texts per inference run, 1 by default. The int8 model quantises each run's activations over
   * the whole batch, so a text's vector would shift slightly with its neighbours; one at a time,
   * a text always gets the same vector (and padding costs nothing). Larger batches are about
   * 10% faster for ticket-sized texts.
   */
  batchSize?: number;
  maxTokens?: number;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

export class LocalEmbedder implements Embedder {
  readonly model = LOCAL_MODEL_ID;
  readonly dimensions = LOCAL_DIMENSIONS;
  private worker: Worker | undefined;
  private tokenizer: Promise<WordPieceTokenizer> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Runs go to the thread one at a time: an inference session takes one run at once. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: {
    modelDir: string | undefined;
    threads: number;
    batchSize: number;
    maxTokens: number;
  };

  constructor(options: LocalEmbedderOptions = {}) {
    this.options = {
      modelDir: options.modelDir,
      threads: options.threads ?? 1,
      batchSize: options.batchSize ?? 1,
      maxTokens: options.maxTokens ?? LOCAL_MAX_TOKENS,
    };
  }

  private dir(): string {
    this.options.modelDir ??= bundledModelDir();
    return this.options.modelDir;
  }

  private loadTokenizer(): Promise<WordPieceTokenizer> {
    this.tokenizer ??= readFile(join(this.dir(), 'vocab.txt'), 'utf8').then(
      (vocab) => new WordPieceTokenizer(vocab),
    );
    return this.tokenizer;
  }

  private thread(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerFile());
    // The thread must not keep the process alive: an idle server or a finished CLI exits.
    worker.unref();
    worker.on('message', (message: { id: number; vectors?: Float32Array[]; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.vectors) pending.resolve(message.vectors);
      else pending.reject(new Error(`the embedding model failed: ${message.error}`));
    });
    const failAll = (error: Error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.worker === worker) this.worker = undefined;
    };
    worker.on('error', failAll);
    worker.on('exit', (code) => failAll(new Error(`the embedding thread stopped (${code})`)));
    const runtimeDir = bundledRuntimeDir();
    worker.postMessage({
      type: 'init',
      model: join(this.dir(), 'model_qint8.onnx'),
      wasmPaths: runtimeDir ? pathToFileURL(runtimeDir).href : undefined,
      threads: this.options.threads,
    });
    this.worker = worker;
    return worker;
  }

  private run(batch: number[][]): Promise<Float32Array[]> {
    const next = this.queue.then(
      () =>
        new Promise<Float32Array[]>((resolve, reject) => {
          const id = this.nextId++;
          // Keep the process alive while a run is out; unref again when it is back.
          const worker = this.thread();
          worker.ref();
          const done = () => worker.unref();
          this.pending.set(id, {
            resolve: (v) => {
              done();
              resolve(v);
            },
            reject: (e) => {
              done();
              reject(e);
            },
          });
          worker.postMessage({ type: 'run', id, batch, dimensions: this.dimensions });
        }),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  /** Loads the model now rather than at the first text. */
  async warm(): Promise<void> {
    await this.embed(['warm']);
  }

  /** Token ids of one text, as the model reads it. */
  async tokenize(text: string): Promise<number[]> {
    return (await this.loadTokenizer()).encode(text, this.options.maxTokens).ids;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const tokenizer = await this.loadTokenizer();
    const encoded = texts.map((text) => tokenizer.encode(text, this.options.maxTokens).ids);
    // Similar lengths in one run pad less.
    const order = encoded
      .map((_, i) => i)
      .sort((a, b) => (encoded[a]?.length ?? 0) - (encoded[b]?.length ?? 0));
    const out = new Array<Float32Array>(texts.length);
    for (let from = 0; from < order.length; from += this.options.batchSize) {
      const batch = order.slice(from, from + this.options.batchSize);
      const vectors = await this.run(batch.map((i) => encoded[i] ?? []));
      batch.forEach((index, row) => {
        const vector = vectors[row];
        if (!vector) throw new Error('the embedding model returned too few vectors');
        out[index] = vector;
      });
    }
    return out;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}

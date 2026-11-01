// The thread that runs the bundled embedding model (M1-078, ADR-106). Inference takes tens of
// milliseconds per text, so it runs here and the server's event loop stays free (NFR-012).
// Plain JavaScript on purpose: it runs as is from source and is bundled with its runtime for
// the image (tools/build/server.mjs), and it only needs token ids, which the caller makes.
//
// Messages in: { type: 'init', model, wasmPaths?, threads } once, then
// { type: 'run', id, batch: number[][], dimensions }. Out: { id, vectors } (unit vectors, mean
// pooled under the attention mask) or { id, error }.
import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

let ready;

async function init(message) {
  const ort = await import('onnxruntime-web');
  if (message.wasmPaths) ort.env.wasm.wasmPaths = message.wasmPaths;
  ort.env.wasm.numThreads = message.threads;
  ort.env.logLevel = 'error';
  const weights = await readFile(message.model);
  const session = await ort.InferenceSession.create(new Uint8Array(weights), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { ort, session };
}

async function run({ ort, session }, batch, dimensions) {
  const width = Math.max(...batch.map((ids) => ids.length));
  const ids = new BigInt64Array(batch.length * width);
  const mask = new BigInt64Array(batch.length * width);
  batch.forEach((tokens, row) => {
    for (let t = 0; t < tokens.length; t++) {
      ids[row * width + t] = BigInt(tokens[t]);
      mask[row * width + t] = 1n;
    }
  });
  const dims = [batch.length, width];
  const result = await session.run({
    input_ids: new ort.Tensor('int64', ids, dims),
    attention_mask: new ort.Tensor('int64', mask, dims),
    token_type_ids: new ort.Tensor('int64', new BigInt64Array(batch.length * width), dims),
  });
  const hidden = result.last_hidden_state;
  if (!hidden) throw new Error('the model returned no last_hidden_state');
  const data = hidden.data;
  const vectors = batch.map((tokens, row) => {
    const vector = new Float32Array(dimensions);
    for (let t = 0; t < tokens.length; t++) {
      const base = (row * width + t) * dimensions;
      for (let d = 0; d < dimensions; d++) vector[d] += data[base + d];
    }
    let norm = 0;
    for (let d = 0; d < dimensions; d++) {
      vector[d] /= tokens.length;
      norm += vector[d] * vector[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < dimensions; d++) vector[d] /= norm;
    return vector;
  });
  for (const tensor of Object.values(result)) tensor.dispose();
  return vectors;
}

parentPort.on('message', async (message) => {
  if (message.type === 'init') {
    ready = init(message);
    ready.catch(() => {});
    return;
  }
  try {
    const vectors = await run(await ready, message.batch, message.dimensions);
    parentPort.postMessage(
      { id: message.id, vectors },
      vectors.map((v) => v.buffer),
    );
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: String(error?.message ?? error) });
  }
});

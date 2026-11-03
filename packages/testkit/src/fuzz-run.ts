import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type FuzzReport, type FuzzTarget, inputAt, runFuzz } from './fuzz';

/**
 * Runs a fuzz target in a worker thread, watched from this one (M1-118, ADR-104). The worker
 * stores the index of the input it is on in shared memory before each input; when that index
 * stays the same for `hangSeconds`, the worker is stopped and the run reports a hang with the
 * input rebuilt from the seed. A parser stuck in a loop never yields, so only another thread
 * can see it.
 *
 * `module` is the file that exports the targets (`export const FUZZ_TARGETS`), by path, so a
 * tool can run targets of a package it may not import (the server's, from devtools).
 */
export interface WatchedRun {
  module: string;
  target: string;
  seed: number;
  seconds: number;
  inputs?: number | undefined;
  hangSeconds?: number;
  onProgress?: (report: FuzzReport) => void;
}

interface WorkerInput {
  module: string;
  target: string;
  seed: number;
  seconds: number;
  inputs?: number | undefined;
  beat: SharedArrayBuffer;
}

type WorkerMessage =
  | { kind: 'progress' | 'done'; report: FuzzReport }
  | { kind: 'error'; message: string };

async function loadTarget(module: string, name: string): Promise<FuzzTarget<unknown>> {
  // A URL, not the path: import() reads a Windows path's drive as a URL scheme.
  const loaded = (await import(pathToFileURL(module).href)) as {
    FUZZ_TARGETS?: readonly FuzzTarget<unknown>[];
  };
  const target = loaded.FUZZ_TARGETS?.find((t) => t.name === name);
  if (!target) throw new Error(`${module} has no fuzz target "${name}"`);
  return target;
}

export function runWatched(run: WatchedRun): Promise<FuzzReport> {
  const beat = new SharedArrayBuffer(8);
  const index = new Float64Array(beat);
  index[0] = -1;
  const data: WorkerInput = {
    module: run.module,
    target: run.target,
    seed: run.seed,
    seconds: run.seconds,
    inputs: run.inputs,
    beat,
  };
  // The worker loads this file through tsx's loader, registered first in the worker itself.
  const tsx = import.meta.resolve('tsx/esm/api');
  const bootstrap = `import { register } from ${JSON.stringify(tsx)}; register(); await import(${JSON.stringify(import.meta.url)});`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    workerData: data,
  });
  const hangMs = (run.hangSeconds ?? 30) * 1000;
  return new Promise<FuzzReport>((resolve, reject) => {
    let last = -1;
    let lastChange = Date.now();
    let latest: FuzzReport | undefined;
    let settled = false;
    let stopping = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      fn();
    };
    const watch = setInterval(() => {
      const now = index[0] as number;
      if (now !== last) {
        last = now;
        lastChange = Date.now();
        return;
      }
      if (stopping || Date.now() - lastChange < hangMs || now < 0) return;
      stopping = true;
      void worker.terminate().then(async () => {
        const target = await loadTarget(run.module, run.target);
        const input = await inputAt(target, run.seed, now);
        const report: FuzzReport = latest ?? {
          target: run.target,
          seed: run.seed,
          seconds: 0,
          inputs: now,
          perSecond: 0,
          failures: [],
          slowest: { ms: 0, input: '' },
          outcomes: {},
        };
        report.inputs = now;
        report.failures.push({
          index: now,
          input: (() => {
            try {
              return target.show(input);
            } catch {
              return `<input ${now} of seed ${run.seed}>`;
            }
          })(),
          problem: `no answer after ${hangMs / 1000} s (hang)`,
        });
        finish(() => resolve(report));
      }, reject);
    }, 1000);
    worker.on('message', (message: WorkerMessage) => {
      if (message.kind === 'error') finish(() => reject(new Error(message.message)));
      else if (message.kind === 'progress') {
        latest = message.report;
        run.onProgress?.(message.report);
      } else finish(() => resolve(message.report));
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (code !== 0 && !stopping) {
        finish(() => reject(new Error(`the fuzz worker stopped with code ${code}`)));
      }
    });
  });
}

if (!isMainThread && parentPort && (workerData as WorkerInput | undefined)?.beat) {
  const input = workerData as WorkerInput;
  const port = parentPort;
  const index = new Float64Array(input.beat);
  loadTarget(input.module, input.target)
    .then((target) =>
      runFuzz(target, {
        seed: input.seed,
        seconds: input.seconds,
        inputs: input.inputs,
        onInput: (i) => {
          index[0] = i;
        },
        onProgress: (report) => port.postMessage({ kind: 'progress', report }),
      }),
    )
    .then(
      (report) => port.postMessage({ kind: 'done', report }),
      (error: unknown) =>
        port.postMessage({
          kind: 'error',
          message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        }),
    );
}

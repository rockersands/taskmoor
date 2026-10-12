import fc from 'fast-check';

/**
 * Property-test defaults for the whole repo. FC_RUNS raises the run count (nightly jobs use
 * thousands); FC_SEED replays a failure that a run printed.
 */
export const propertyRuns = Number.parseInt(process.env.FC_RUNS ?? '100', 10);

const seed = process.env.FC_SEED ? Number.parseInt(process.env.FC_SEED, 10) : undefined;

fc.configureGlobal(
  seed === undefined ? { numRuns: propertyRuns } : { numRuns: propertyRuns, seed },
);

export { fc };

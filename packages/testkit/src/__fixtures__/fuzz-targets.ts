import type { FuzzTarget } from '../fuzz';

/** Targets for the harness's own tests: one that hangs on its fifth input, one that throws. */
export const FUZZ_TARGETS: readonly FuzzTarget<unknown>[] = [
  {
    name: 'hangs',
    description: 'loops forever on input 4',
    seeds: () => ['a'],
    generate: (rng) => String(rng.int(0, 1_000_000)),
    check: (() => {
      let n = 0;
      return () => {
        if (n++ === 4) for (;;) {}
        return 'ok';
      };
    })(),
    show: (s) => String(s),
  } satisfies FuzzTarget<string> as FuzzTarget<unknown>,
];

import { concat, sha256, utf8 } from './bytes';

/**
 * Where generated secrets come from (M1-109; OPS-014, OPS-016). The Builder uses the platform's
 * cryptographic generator. A seed makes a run reproducible, so the CLI and the web Builder
 * produce byte-identical kits from one project file and seed (OPS-016 (2)); the secrets are then
 * only as strong as the seed, which is why it is meant for tests and for rebuilding a kit, never
 * for a first install.
 */
export interface RandomSource {
  bytes(length: number): Promise<Uint8Array<ArrayBuffer>>;
}

export const systemRandom: RandomSource = {
  bytes: async (length) => {
    const out = new Uint8Array(length);
    // getRandomValues takes at most 65,536 bytes a call.
    for (let at = 0; at < length; at += 65_536) {
      crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536)));
    }
    return out;
  },
};

/** The shortest seed taken: shorter ones are guessable, whatever they are for. */
export const MIN_SEED_LENGTH = 16;

/** SHA-256 in counter mode over the seed: block i is SHA-256(label, seed, i). */
export function seededRandom(seed: string): RandomSource {
  if (seed.length < MIN_SEED_LENGTH) {
    throw new Error(`A seed needs at least ${MIN_SEED_LENGTH} characters.`);
  }
  let counter = 0;
  let pool = new Uint8Array(0);
  return {
    async bytes(length) {
      while (pool.length < length) {
        const block = await sha256(
          concat(utf8('taskmoor-builder-seed-v1\n'), utf8(seed), utf8(`\n${counter++}`)),
        );
        pool = concat(pool, block);
      }
      const out = pool.slice(0, length);
      pool = pool.slice(length);
      return out;
    },
  };
}

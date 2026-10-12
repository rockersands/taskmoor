/**
 * Small, fast, seedable PRNG (sfc32 seeded through splitmix32). Synthetic data must be
 * reproducible across machines and Node versions, so Math.random is never used.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const split = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = split();
    this.b = split();
    this.c = split();
    this.d = split();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** An independent stream for one entity, e.g. `Rng.derive(seed, 'item', 41)`. */
  static derive(seed: number, label: string, index = 0): Rng {
    let h = (seed ^ 0x2545f491) >>> 0;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ index, 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ Math.floor(index / 0x100000000), 0x85ebca6b) >>> 0;
    return new Rng(h);
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks by relative weight: `weighted([['a', 3], ['b', 1]])` returns 'a' about 75% of the time. */
  weighted<T>(choices: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of choices) total += w;
    let r = this.next() * total;
    for (const [value, w] of choices) {
      r -= w;
      if (r < 0) return value;
    }
    return (choices[choices.length - 1] as readonly [T, number])[0];
  }

  /** Geometric count with the given mean (0, 1, 2, ...). */
  geometric(mean: number): number {
    if (mean <= 0) return 0;
    const p = 1 / (mean + 1);
    return Math.floor(Math.log(1 - this.next()) / Math.log(1 - p));
  }

  /** Exponential sample with the given mean. */
  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }
}

/**
 * Samples indexes 0..n-1 with a Zipf-like skew: index 0 is the most popular. Real trackers look
 * like this: a few spaces and people own most of the work.
 */
export class ZipfSampler {
  private readonly cumulative: Float64Array;

  constructor(
    readonly size: number,
    exponent = 1.07,
  ) {
    if (size < 1) throw new Error('ZipfSampler needs at least one item');
    this.cumulative = new Float64Array(size);
    let total = 0;
    for (let i = 0; i < size; i++) {
      total += 1 / (i + 1) ** exponent;
      this.cumulative[i] = total;
    }
    for (let i = 0; i < size; i++) this.cumulative[i] = (this.cumulative[i] ?? 0) / total;
  }

  sample(rng: Rng): number {
    const r = rng.next();
    let lo = 0;
    let hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (r < (this.cumulative[mid] ?? 1)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

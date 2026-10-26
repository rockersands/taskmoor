/**
 * Keys for the global rank (AGL-009): one order over every ticket of a workspace, shared by all
 * boards and backlogs. Rank keys are fractional: strings over 62 digits that compare by code
 * unit (the column uses the "C" collation), so moving a ticket between two others gives it a
 * key between theirs and rewrites nothing else.
 *
 * - A key is an integer part and an optional fraction. The first character of the integer part
 *   says how many digits follow it: `a` one, `b` two, up to `z` with 26 for the non-negative
 *   integers, and `Z` one, `Y` two, down to `A` for the negative ones. Integers therefore sort
 *   as strings, and a run of appends grows the key by one character per factor of 62.
 * - New tickets go to the bottom with a key made from the next value of a database sequence
 *   (`sequenceKey`): concurrent creates never pick the same key and never wait for each other.
 *   Only sequence keys ever extend the order at the bottom, so every later sequence key sorts
 *   after every key in use.
 * - A key between two neighbours (`keyBetween`) takes a random digit from the middle half of the
 *   gap, so two moves into the same gap at the same moment rarely pick the same key; the unique
 *   index on (workspace, rank) turns that rare clash into a retry.
 * - A fraction never ends with the digit 0, so there is always room between two keys.
 */
export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = RANK_DIGITS.length;
const ZERO = RANK_DIGITS[0] as string;
const LAST = RANK_DIGITS[BASE - 1] as string;
/** The smallest integer part; a key may not be this integer alone, so the top stays open. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

function digit(char: string | undefined): number {
  const value = char === undefined ? -1 : RANK_DIGITS.indexOf(char);
  if (value < 0) throw new RangeError(`not a rank digit: ${char}`);
  return value;
}

/** How long the integer part starting with `head` is, head included. */
function integerLength(head: string | undefined): number {
  if (head !== undefined && head >= 'a' && head <= 'z') return head.charCodeAt(0) - 95;
  if (head !== undefined && head >= 'A' && head <= 'Z') return 92 - head.charCodeAt(0);
  throw new RangeError(`not a rank key head: ${head}`);
}

function split(key: string): { integer: string; fraction: string } {
  const length = integerLength(key[0]);
  if (key.length < length) throw new RangeError(`rank key too short: ${key}`);
  return { integer: key.slice(0, length), fraction: key.slice(length) };
}

/** Whether `key` is a well-formed rank key. */
export function isRankKey(key: string): boolean {
  try {
    const { fraction } = split(key);
    for (const c of key.slice(1)) digit(c);
    return key !== SMALLEST_INTEGER && !fraction.endsWith(ZERO);
  } catch {
    return false;
  }
}

function check(key: string): void {
  if (!isRankKey(key)) throw new RangeError(`not a rank key: ${key}`);
}

/** The next integer part, or null past the largest one. */
function increment(integer: string): string | null {
  const head = integer[0] as string;
  const digits = [...integer.slice(1)];
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = digit(digits[i]) + 1;
    if (next < BASE) {
      digits[i] = RANK_DIGITS[next] as string;
      return head + digits.join('');
    }
    digits[i] = ZERO;
  }
  // Every digit wrapped: move to the next head, one digit longer above zero, shorter below.
  if (head === 'Z') return `a${ZERO}`;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

/** The previous integer part, or null below the smallest one. */
function decrement(integer: string): string | null {
  const head = integer[0] as string;
  const digits = [...integer.slice(1)];
  for (let i = digits.length - 1; i >= 0; i--) {
    const next = digit(digits[i]) - 1;
    if (next >= 0) {
      digits[i] = RANK_DIGITS[next] as string;
      return head + digits.join('');
    }
    digits[i] = LAST;
  }
  if (head === 'a') return `Z${LAST}`;
  if (head === 'A') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < 'Z') digits.push(LAST);
  else digits.pop();
  return nextHead + digits.join('');
}

/**
 * A fraction strictly between `a` and `b` (null: no upper bound). Neither ends with 0, and the
 * result does not either.
 */
function midpoint(a: string, b: string | null, random: () => number): string {
  if (b !== null) {
    // A shared prefix stays; a shorter `a` reads as padded with zeros.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), random);
  }
  const low = a === '' ? 0 : digit(a[0]);
  const high = b === null ? BASE : digit(b[0]);
  const gap = high - low;
  if (gap > 1) {
    // A digit from the middle half of the gap: random, but never hugging either side.
    const margin = Math.max(1, Math.floor(gap / 4));
    const from = low + margin;
    const to = high - margin;
    return RANK_DIGITS[from + Math.floor(random() * (to - from + 1))] as string;
  }
  // Neighbouring digits: `b`'s first digit alone fits if more of `b` follows it.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (RANK_DIGITS[low] as string) + midpoint(a.slice(1), null, random);
}

/**
 * A key strictly between `a` and `b`; null stands for the top (`a`) or the bottom (`b`) of the
 * order. Tickets never use a null `b`: they reach the bottom by `sequenceKey`, and a key past
 * the last one could be a sequence key that a later create takes.
 */
export function keyBetween(
  a: string | null,
  b: string | null,
  random: () => number = Math.random,
): string {
  if (a !== null) check(a);
  if (b !== null) check(b);
  if (a !== null && b !== null && a >= b) throw new RangeError(`${a} is not before ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const { integer, fraction } = split(b);
    if (integer === SMALLEST_INTEGER) return integer + midpoint('', fraction, random);
    // `b` has a fraction, so its integer part alone sorts just before it.
    if (fraction !== '') return integer;
    const before = decrement(integer);
    if (before === null) throw new RangeError('no rank key before the smallest');
    // The smallest integer alone is no key: it takes a fraction instead.
    return before === SMALLEST_INTEGER ? before + midpoint('', null, random) : before;
  }
  const { integer: ia, fraction: fa } = split(a);
  if (b === null) {
    const after = increment(ia);
    return after ?? ia + midpoint(fa, null, random);
  }
  const { integer: ib, fraction: fb } = split(b);
  if (ia === ib) return ia + midpoint(fa, fb, random);
  const after = increment(ia);
  if (after !== null && after < b) return after;
  return ia + midpoint(fa, null, random);
}

/**
 * The key of the `n`th non-negative integer: `a0`, `a1`, ..., `az`, `b00`, ... in the order
 * `keyBetween(key, null)` steps through them. New tickets take the key of the next value of
 * the rank sequence, which is how they land at the bottom.
 */
export function sequenceKey(n: bigint | number | string): string {
  let rest = BigInt(n);
  if (rest < 0n) throw new RangeError(`not a sequence value: ${n}`);
  const base = BigInt(BASE);
  for (let length = 1; length <= 26; length++) {
    const count = base ** BigInt(length);
    if (rest < count) {
      let digits = '';
      for (let i = 0; i < length; i++) {
        digits = (RANK_DIGITS[Number(rest % base)] as string) + digits;
        rest /= base;
      }
      return String.fromCharCode(96 + length) + digits;
    }
    rest -= count;
  }
  throw new RangeError(`sequence value too large for a rank key: ${n}`);
}

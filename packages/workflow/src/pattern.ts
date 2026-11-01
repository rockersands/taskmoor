/**
 * Regular expressions that administrators write into workflow validators run on ticket text
 * that anyone may type, in Node's backtracking engine. A pattern with nested unbounded
 * repetition (`(a+)+`), repeated alternation (`(a|aa)*`) or a backreference can take
 * exponential time on a short input and stall the server for everyone (ReDoS). Such patterns
 * are refused when a workflow is saved and never run (M1-118, found by the SAST scan's
 * `detect-non-literal-regexp`; ADR-104). The check is conservative: it reads the pattern's
 * structure, not its meaning, so a few harmless patterns are refused too; they can always be
 * written without the nesting.
 */
export const MAX_PATTERN_LENGTH = 500;

interface Group {
  /** An unbounded quantifier (`*`, `+`, `{n,}`, large `{n,m}`) inside the group. */
  repeats: boolean;
  alternates: boolean;
}

/** Why a pattern may backtrack catastrophically, or null when it is safe to run. */
export function unsafePattern(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return 'too long';
  const stack: Group[] = [{ repeats: false, alternates: false }];
  let i = 0;
  /** Reads a quantifier at `i`; returns whether it is unbounded, and moves past it. */
  const quantifier = (): boolean | null => {
    const c = pattern[i];
    if (c === '*' || c === '+') {
      i++;
      if (pattern[i] === '?' || pattern[i] === '+') i++;
      return true;
    }
    if (c === '?') {
      i++;
      if (pattern[i] === '?') i++;
      return false;
    }
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!m) return null;
      i += m[0].length;
      if (pattern[i] === '?') i++;
      const max =
        m[2] === undefined ? Number(m[1]) : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3]);
      return max > 10;
    }
    return null;
  };
  while (i < pattern.length) {
    const c = pattern[i] as string;
    const top = stack[stack.length - 1] as Group;
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return 'a backreference';
      i += 2;
    } else if (c === '[') {
      // A character class: skip to its unescaped end.
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '(') {
      stack.push({ repeats: false, alternates: false });
      i++;
      if (pattern[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        i++;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          while (i < pattern.length && pattern[i] !== '>') i++;
        }
        i++;
      }
      continue;
    } else if (c === ')') {
      i++;
      if (stack.length === 1) return 'an unbalanced parenthesis';
      const group = stack.pop() as Group;
      const parent = stack[stack.length - 1] as Group;
      const unbounded = quantifier();
      if (unbounded) {
        if (group.repeats) return 'nested repetition';
        if (group.alternates) return 'repeated alternation';
      }
      parent.repeats ||= group.repeats || unbounded === true;
      parent.alternates ||= false;
      continue;
    } else if (c === '|') {
      top.alternates = true;
      i++;
    } else {
      i++;
    }
    const q = quantifier();
    if (q) top.repeats = true;
  }
  if (stack.length !== 1) return 'an unbalanced parenthesis';
  return null;
}

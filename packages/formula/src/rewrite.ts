import type { RefUse } from './program';

/**
 * Rewrites the field references of a checked formula and keeps everything else as written: a
 * formula is stored with fields by id (`{cf[12]}`), so renaming a field never breaks it, and
 * shown with their names (`{Points}`).
 */
export function rewriteRefs(
  source: string,
  refs: readonly RefUse[],
  token: (ref: RefUse) => string,
): string {
  const sorted = [...refs].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const ref of sorted) {
    if (ref.start < at) continue;
    out += source.slice(at, ref.start) + token(ref);
    at = ref.end;
  }
  return out + source.slice(at);
}

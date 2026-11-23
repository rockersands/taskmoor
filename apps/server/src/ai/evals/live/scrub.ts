/**
 * Keeps the API key out of everything `pnpm ai:live` prints or keeps (T-333; IAM-020): the
 * children's output, their reports and the summary. Output is scrubbed a line at a time, so a
 * key that arrives split across two chunks is still caught whole; the key has no line break.
 */

export const KEY_MARK = '[key]';
export const PART_OF_KEY_LINE = '[a line that held part of the key was left out]';

/** The shortest piece of the key that marks a line as holding part of it. */
const PIECE = 16;

/**
 * A function that replaces the key, as written and as JSON escapes it, with `[key]`, and drops
 * any line that still holds a piece of it 16 characters or longer (a key cut short).
 */
export function keyScrubber(key: string): (text: string) => string {
  if (key.length === 0) return (text) => text;
  const forms = [...new Set([key, JSON.stringify(key).slice(1, -1)])];
  const pieces: string[] = [];
  for (let i = 0; i + PIECE <= key.length; i++) pieces.push(key.slice(i, i + PIECE));
  return (text) => {
    let out = text;
    for (const form of forms) out = out.split(form).join(KEY_MARK);
    if (pieces.length === 0 || !pieces.some((p) => out.includes(p))) return out;
    return out
      .split('\n')
      .map((line) => (pieces.some((p) => line.includes(p)) ? PART_OF_KEY_LINE : line))
      .join('\n');
  };
}

/** Collects a stream's text into whole lines, scrubs each and hands it on. */
export class LineScrubber {
  private partial = '';

  constructor(
    private readonly scrub: (text: string) => string,
    private readonly emit: (line: string) => void,
  ) {}

  push(chunk: string): void {
    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.emit(this.scrub(line.replace(/\r$/, '')));
  }

  end(): void {
    if (this.partial) this.emit(this.scrub(this.partial.replace(/\r$/, '')));
    this.partial = '';
  }
}

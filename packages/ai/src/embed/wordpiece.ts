/**
 * The tokenizer of the bundled embedding model (M1-078, AI-012; ADR-106), written from the
 * published description of BERT's uncased tokenizer: text is cleaned, lower-cased and stripped
 * of accents, split on white space and around punctuation and CJK ideographs, and each word is
 * cut into the longest pieces the vocabulary holds, greedily from the left; a piece inside a
 * word carries the `##` prefix. A word with a part the vocabulary lacks, or longer than 100
 * characters, becomes `[UNK]`. The sequence is `[CLS]`, the pieces, `[SEP]`, at most
 * `maxTokens` long in all.
 */

const MAX_WORD_CHARS = 100;
const CONTINUATION = '##';

export interface Encoding {
  /** Token ids, starting with `[CLS]` and ending with `[SEP]`. */
  ids: number[];
  /** Whether word pieces were dropped to fit `maxTokens`. */
  truncated: boolean;
}

const PUNCTUATION = /\p{P}/u;
const CONTROL = /\p{C}/u;
const SPACE_SEPARATOR = /\p{Zs}/u;
const COMBINING_MARK = /\p{Mn}/gu;

/** ASCII symbols count as punctuation too ($, +, ^, `), as the original tokenizer has it. */
function isPunctuation(code: number, char: string): boolean {
  if (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  ) {
    return true;
  }
  return PUNCTUATION.test(char);
}

function isWhitespace(code: number, char: string): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || SPACE_SEPARATOR.test(char);
}

/** Tab, line feed and carriage return are white space, not control characters. */
function isControl(code: number, char: string): boolean {
  if (code === 9 || code === 10 || code === 13) return false;
  return CONTROL.test(char);
}

/** The CJK Unified Ideographs blocks, which the tokenizer splits into single characters. */
function isIdeograph(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

export class WordPieceTokenizer {
  readonly clsId: number;
  readonly sepId: number;
  readonly padId: number;
  readonly unkId: number;
  private readonly vocab: Map<string, number>;

  /** `vocab` is the vocabulary file: one token per line, its id the line's index. */
  constructor(vocab: string) {
    this.vocab = new Map();
    const lines = vocab.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const token = (lines[i] ?? '').replace(/\r$/, '');
      if (token !== '' && !this.vocab.has(token)) this.vocab.set(token, i);
    }
    const special = (token: string) => {
      const id = this.vocab.get(token);
      if (id === undefined) throw new Error(`the vocabulary has no ${token}`);
      return id;
    };
    this.clsId = special('[CLS]');
    this.sepId = special('[SEP]');
    this.padId = special('[PAD]');
    this.unkId = special('[UNK]');
  }

  get size(): number {
    return this.vocab.size;
  }

  /** The words before word pieces: cleaned, lower-cased, without accents, split. */
  words(text: string): string[] {
    let spaced = '';
    for (const char of text) {
      const code = char.codePointAt(0) as number;
      if (code === 0 || code === 0xfffd || isControl(code, char)) continue;
      if (isWhitespace(code, char)) spaced += ' ';
      else if (isIdeograph(code)) spaced += ` ${char} `;
      else spaced += char;
    }
    const words: string[] = [];
    for (const raw of spaced.split(' ')) {
      if (raw === '') continue;
      const word = raw.toLowerCase().normalize('NFD').replace(COMBINING_MARK, '');
      let current = '';
      for (const char of word) {
        if (isPunctuation(char.codePointAt(0) as number, char)) {
          if (current !== '') words.push(current);
          words.push(char);
          current = '';
        } else {
          current += char;
        }
      }
      if (current !== '') words.push(current);
    }
    return words;
  }

  /** One word's pieces as ids: greedy longest match, or `[UNK]` alone. */
  pieces(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > MAX_WORD_CHARS) return [this.unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const piece = chars.slice(start, end).join('');
        found = this.vocab.get(start > 0 ? CONTINUATION + piece : piece);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unkId];
      ids.push(found);
      start = end;
    }
    return ids;
  }

  /** `[CLS]`, the text's pieces and `[SEP]`, at most `maxTokens` ids. */
  encode(text: string, maxTokens = 256): Encoding {
    const room = Math.max(0, maxTokens - 2);
    const ids = [this.clsId];
    let truncated = false;
    for (const word of this.words(text)) {
      const pieces = this.pieces(word);
      if (ids.length - 1 + pieces.length > room) {
        ids.push(...pieces.slice(0, room - (ids.length - 1)));
        truncated = true;
        break;
      }
      ids.push(...pieces);
    }
    ids.push(this.sepId);
    return { ids, truncated };
  }
}

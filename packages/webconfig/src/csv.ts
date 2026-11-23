/**
 * CSV files as every export writes them, on the server and on the page (T-252; ADR-122 stage 8):
 * the search results, a plan's List, the audit log, and the files a plan's other views build in
 * the browser. One rule for all of them, so the files read the same wherever they were made:
 *
 * - RFC 4180: fields separated by a comma or a semicolon (the style), CRLF between records,
 *   quotes doubled inside quotes;
 * - a formula guard: text a spreadsheet would run as a formula gets a leading apostrophe;
 * - text with a comma or a semicolon is quoted, in either style, as some spreadsheets split cells
 *   at each (Spanish settings at the semicolon); so is text with a tab or a `|`, the other
 *   separators an importer looks for, so a file's own separators are the only ones outside quotes;
 * - **a UTF-8 byte-order mark first, exactly once** (the user's decision of 2026-11-13, T-241
 *   stage 8 question 7): Excel on Windows opens a file by a double-click as the system's legacy
 *   code page unless it starts with one, and accented headers such as "Versión" come out garbled.
 *   Both styles get it.
 *
 * **Two styles** (T-263, the answer of 2026-11-16): `comma` writes commas between cells and
 * numbers as 1.5; `semicolon` writes semicolons and numbers as 1,5, which is what a spreadsheet
 * set up for a decimal comma (Spain, most of Europe, Brazil) opens by a double-click in columns.
 * The API's default is the comma; the web app picks the style for the person
 * (`automaticCsvSeparator`, or the choice on their profile).
 *
 * The importers take the mark off again (`bomLength`) and find the separator when a mapping does
 * not name one (`detectDelimiter`), so an exported file imports as it is.
 */

/** U+FEFF: as the first character of a UTF-8 file, its three bytes EF BB BF. */
export const CSV_BOM = '﻿';

/** The type every CSV answer and download carries. */
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * How a file separates its cells and writes numbers: `comma` (1.5) or `semicolon` (1,5). The
 * name is what the API's `separator` parameter and the profile setting take.
 */
export const CSV_SEPARATORS = ['comma', 'semicolon'] as const;
export type CsvSeparator = (typeof CSV_SEPARATORS)[number];

const MARK: Record<CsvSeparator, string> = { comma: ',', semicolon: ';' };

/**
 * One CSV field (RFC 4180). Text a spreadsheet would run as a formula (starting with =, +, -,
 * @, tab or carriage return, or their full-width forms) gets a leading apostrophe, so an exported
 * name cannot become one. Text with a comma or a semicolon is quoted in both styles: a spreadsheet
 * whose list separator is the other one would otherwise split the cell there. Text with a tab or a
 * `|` is quoted too, so `detectDelimiter` finds the file's own separator. A number stays a
 * number, so -3 is not a formula; the semicolon style writes its decimal mark as a comma (2,5),
 * unquoted, since the comma is not that file's separator.
 */
export function csvField(value: unknown, separator: CsvSeparator = 'comma'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const text = String(value);
    return separator === 'semicolon' ? text.replace('.', ',') : text;
  }
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r＝＋－＠]/.test(text)) text = `'${text}`;
  return /[",;\t|\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record, its line end included. */
export const csvLine = (cells: readonly unknown[], separator: CsvSeparator = 'comma'): string =>
  `${cells.map((cell) => csvField(cell, separator)).join(MARK[separator])}\r\n`;

/**
 * A file's text with the byte-order mark in front, exactly once: text that already starts with
 * one is returned as it is. A streamed export passes its first chunk through this.
 */
export const withBom = (text: string): string =>
  text.startsWith(CSV_BOM) ? text : `${CSV_BOM}${text}`;

/** A whole file: the mark, then each row as a record. */
export const csvFile = (
  rows: readonly (readonly unknown[])[],
  separator: CsvSeparator = 'comma',
): string => withBom(rows.map((row) => csvLine(row, separator)).join(''));

/**
 * The style for a person whose numbers follow a BCP 47 tag (their account's "Language and
 * region", else the browser's language): `semicolon` when the tag writes a decimal comma
 * (es-ES 1,5; de-DE; fr-FR; pt-BR), `comma` when it writes a decimal point (es-MX 1.5; en-US).
 * Spreadsheets on Windows take ';' between cells exactly when the decimal mark is ','. A tag
 * the browser does not know reads as a decimal point.
 *
 * Known gap: Swiss German (de-CH) writes a decimal point, so it gets commas, but Excel there
 * separates cells with ';'. Such a person picks the semicolon style on their profile, which also
 * writes decimal commas (T-263).
 */
export function automaticCsvSeparator(tag: string | null | undefined): CsvSeparator {
  try {
    const parts = new Intl.NumberFormat(tag ?? undefined).formatToParts(1.5);
    return parts.find((p) => p.type === 'decimal')?.value === ',' ? 'semicolon' : 'comma';
  } catch {
    return 'comma';
  }
}

/**
 * How many bytes of a file's start are a UTF-8 byte-order mark: 3 or 0. An importer starts
 * reading after them, so the mark never becomes part of the first header.
 */
export const bomLength = (bytes: ArrayLike<number>): number =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

/** The separators an importer reads, in the order a tie between them is broken. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/**
 * The separator of a file (T-263), from its header record alone: each of `,` `;` tab and `|` is
 * counted outside quotes up to the first line end outside quotes (a UTF-8 byte-order mark
 * skipped), and the most frequent wins; a tie, or a header of one column, goes to the comma, then
 * in that order. It reads the bytes only, so every job part of an import gets the same answer.
 */
export function detectDelimiter(bytes: ArrayLike<number>): CsvDelimiter {
  const codes = CSV_DELIMITERS.map((d) => d.charCodeAt(0));
  const counts = codes.map(() => 0);
  let quoted = false;
  for (let i = bomLength(bytes); i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === 0x22) quoted = !quoted;
    else if (quoted) continue;
    else if (b === 0x0a || b === 0x0d) break;
    else {
      const at = codes.indexOf(b);
      if (at >= 0) counts[at] = (counts[at] as number) + 1;
    }
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) {
    if ((counts[i] as number) > (counts[best] as number)) best = i;
  }
  return CSV_DELIMITERS[best] as CsvDelimiter;
}

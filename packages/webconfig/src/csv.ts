/**
 * CSV files as every export writes them, on the server and on the page (T-252; ADR-122 stage 8):
 * the search results, a plan's List, the audit log, and the files a plan's other views build in
 * the browser. One rule for all of them, so the files read the same wherever they were made:
 *
 * - RFC 4180: fields separated by commas, CRLF between records, quotes doubled inside quotes;
 * - a formula guard: text a spreadsheet would run as a formula gets a leading apostrophe;
 * - a semicolon is quoted, as some spreadsheets split cells there (Spanish settings among them);
 * - **a UTF-8 byte-order mark first, exactly once** (the user's decision of 2026-11-13, T-241
 *   stage 8 question 7): Excel on Windows opens a file by a double-click as the system's legacy
 *   code page unless it starts with one, and accented headers such as "Versión" come out garbled.
 *   The separator stays a comma; the mark does not change it.
 *
 * The importers take the mark off again (`bomLength`), so an exported file imports as it is.
 */

/** U+FEFF: as the first character of a UTF-8 file, its three bytes EF BB BF. */
export const CSV_BOM = '﻿';

/** The type every CSV answer and download carries. */
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * One CSV field (RFC 4180). Text a spreadsheet would run as a formula (starting with =, +, -,
 * @, tab or carriage return, or their full-width forms) gets a leading apostrophe, so an exported
 * name cannot become one. A semicolon is quoted too: where a list separator is a semicolon, as in
 * Spanish settings, a spreadsheet would split the cell there and read what follows as a new cell.
 * A number stays a number, so -3 is not a formula.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r＝＋－＠]/.test(text)) text = `'${text}`;
  return /[",;\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record, its line end included. */
export const csvLine = (cells: readonly unknown[]): string =>
  `${cells.map(csvField).join(',')}\r\n`;

/**
 * A file's text with the byte-order mark in front, exactly once: text that already starts with
 * one is returned as it is. A streamed export passes its first chunk through this.
 */
export const withBom = (text: string): string =>
  text.startsWith(CSV_BOM) ? text : `${CSV_BOM}${text}`;

/** A whole file: the mark, then each row as a record. */
export const csvFile = (rows: readonly (readonly unknown[])[]): string =>
  withBom(rows.map(csvLine).join(''));

/**
 * How many bytes of a file's start are a UTF-8 byte-order mark: 3 or 0. An importer starts
 * reading after them, so the mark never becomes part of the first header.
 */
export const bomLength = (bytes: ArrayLike<number>): number =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

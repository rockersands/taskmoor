/**
 * Minimal RFC 4180 CSV: comma separated, fields optionally wrapped in double quotes, quotes
 * escaped by doubling, CRLF or LF line ends. Enough for the plan files; no dependencies.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const input = text.startsWith('﻿') ? text.slice(1) : text;

  while (i < input.length) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Serialises rows, quoting only fields that need it, with LF line ends. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row.map((f) => (/[",\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(','),
    )
    .map((line) => `${line}\n`)
    .join('');
}

/** Parses a CSV with a header row into one object per data row, keyed by header name. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows
    .filter((row) => row.some((f) => f.trim() !== ''))
    .map((row, index) => {
      if (row.length !== header.length) {
        throw new Error(
          `CSV row ${index + 2} has ${row.length} fields; the header has ${header.length}`,
        );
      }
      return Object.fromEntries(header.map((name, i) => [name, row[i] ?? '']));
    });
}

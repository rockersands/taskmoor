import { z } from 'zod';
import { CsvFormatError, records } from '../csv';

/**
 * How a Cloud REST import finds the Taskmoor person for each source person (M1-095; IMP-007;
 * ADR-094):
 *
 * - `email` (the default): by address, as other importers do; a person the target lacks is
 *   created, one whose address the source hides becomes a placeholder.
 * - `csv`: a file of two columns, the source person (account id or address) and the Taskmoor
 *   person's address. People it does not name, and people it names someone the target lacks
 *   for, are left unmapped.
 * - `scim`: the person the identity provider provisioned over SCIM with the same address;
 *   anyone else is left unmapped.
 *
 * An unmapped person becomes a deactivated placeholder, so attribution stays, and the report
 * lists them (`person_unmapped`) for mapping before the final run.
 */
export const MAX_PEOPLE_ROWS = 100_000;

const address = z.string().trim().toLowerCase().email().max(320);

export const peopleSettings = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('email') }).strict(),
  z.object({ mode: z.literal('scim') }).strict(),
  z
    .object({
      mode: z.literal('csv'),
      /** Source account id or address (lower case) to the Taskmoor person's address. */
      rows: z
        .array(z.object({ source: z.string().min(1).max(320), target: address }).strict())
        .max(MAX_PEOPLE_ROWS),
    })
    .strict(),
]);
export type PeopleSettings = z.infer<typeof peopleSettings>;

/** The people CSV as the route takes it; a header row is optional. */
export function parsePeopleCsv(text: string): { source: string; target: string }[] {
  const out: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  const buf = Buffer.from(text, 'utf8');
  let first = true;
  for (const record of records(buf, ',')) {
    const [rawSource = '', rawTarget = ''] = record.fields.map((f) => f.trim());
    const header = first && !rawTarget.includes('@');
    first = false;
    if (header) continue;
    if (rawSource === '') throw new CsvFormatError(record.line, 'the source person is empty');
    const target = address.safeParse(rawTarget);
    if (!target.success) {
      throw new CsvFormatError(record.line, 'the Taskmoor person is not an email address');
    }
    const source = rawSource.includes('@') ? rawSource.toLowerCase() : rawSource;
    if (seen.has(source)) throw new CsvFormatError(record.line, 'the source person is named twice');
    seen.add(source);
    out.push({ source, target: target.data });
    if (out.length > MAX_PEOPLE_ROWS) {
      throw new CsvFormatError(record.line, `more than ${MAX_PEOPLE_ROWS} people`);
    }
  }
  return out;
}

/** What the mapping says of one source person: the address to look for and how. */
export interface PersonMapping {
  email: string | null;
  link?: 'existing' | 'scim';
}

export function personMapping(
  settings: PeopleSettings,
  accountId: string,
  email: string | null,
  lookup: ReadonlyMap<string, string> | null,
): PersonMapping {
  if (settings.mode === 'email') return { email };
  if (settings.mode === 'scim') return { email, link: 'scim' };
  const target =
    lookup?.get(accountId) ?? (email === null ? undefined : lookup?.get(email.toLowerCase()));
  return { email: target ?? null, link: 'existing' };
}

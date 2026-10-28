import type { JsonValue } from '@taskmoor/db';
import { MAX_DURATION_SECONDS } from '../tickets/duration';
import { checkLabels } from '../tickets/fields';
import { checkRichText, isCalendarDay, SUMMARY_MAX } from '../tickets/model';
import type { TicketRow } from '../tickets/store';

/**
 * The ticket fields workflows read and write (M1-024 to M1-027), named as the workflow model
 * names them (spec 01a section 3: `close-reason`, `due-date` and so on). Guards and checks read
 * them; transition layouts and effects write the writable ones. References read and travel as
 * strings of ids, as the engine compares values by content; the server turns them back into
 * ids when it stores them. Custom fields join with M1-010.
 */
export type FieldValue = unknown;
type Parsed = { ok: true; value: FieldValue } | { ok: false; problem: string };

interface FieldSpec {
  read: (row: TicketRow) => FieldValue;
  /** A value given to a layout or set by an effect, in engine form, or why it cannot be. */
  parse?: (input: unknown) => Parsed;
}

const ok = (value: FieldValue): Parsed => ({ ok: true, value });
const bad = (problem: string): Parsed => ({ ok: false, problem });
const idText = (id: number | null) => (id === null ? null : String(id));
const isId = (v: unknown) =>
  (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2_147_483_647) ||
  (typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && Number(v) <= 2_147_483_647);

/** One reference: an id as a number or a string; null clears it. */
const reference = (input: unknown): Parsed =>
  input === null ? ok(null) : isId(input) ? ok(String(input)) : bad('invalid');

/** A list of references, each once. */
const references = (input: unknown): Parsed => {
  if (input === null) return ok([]);
  if (!Array.isArray(input) || input.length > 100 || !input.every(isId)) return bad('invalid');
  return ok([...new Set(input.map(String))]);
};

const date = (input: unknown): Parsed =>
  input === null
    ? ok(null)
    : typeof input === 'string' && isCalendarDay(input)
      ? ok(input)
      : bad('invalid');

const seconds = (input: unknown): Parsed =>
  input === null
    ? ok(null)
    : typeof input === 'number' &&
        Number.isInteger(input) &&
        input >= 0 &&
        input <= MAX_DURATION_SECONDS
      ? ok(input)
      : bad('invalid');

const richText = (input: unknown): Parsed => {
  if (input === null) return ok(null);
  const checked = checkRichText(input);
  return checked.ok ? ok(checked.doc as JsonValue) : bad(checked.problem);
};

export const WORKFLOW_FIELDS: Readonly<Record<string, FieldSpec>> = {
  summary: {
    read: (r) => r.summary,
    parse: (v) => {
      if (typeof v !== 'string') return bad('invalid');
      const s = v.trim();
      if (s === '') return bad('required');
      if ([...s].length > SUMMARY_MAX) return bad('too_long');
      return /[\r\n]/.test(s) ? bad('invalid') : ok(s);
    },
  },
  description: { read: (r) => r.description, parse: richText },
  environment: { read: (r) => r.environment, parse: richText },
  // Assignee and close reason are the ticket's own in the model; they parse like the others.
  assignee: { read: (r) => idText(r.assignee_id), parse: reference },
  'close-reason': { read: (r) => idText(r.close_reason_id), parse: reference },
  priority: { read: (r) => idText(r.priority_id), parse: reference },
  labels: {
    read: (r) => r.labels,
    parse: (v) => {
      if (v === null) return ok([]);
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return bad('invalid');
      const checked = checkLabels(v as string[]);
      return checked.ok ? ok(checked.labels) : bad(checked.problem);
    },
  },
  'start-date': { read: (r) => r.start_date, parse: date },
  'due-date': { read: (r) => r.due_date, parse: date },
  'original-estimate': { read: (r) => r.original_estimate, parse: seconds },
  'remaining-estimate': { read: (r) => r.remaining_estimate, parse: seconds },
  'target-release': { read: (r) => r.target_releases.map((x) => String(x.id)), parse: references },
  'found-in-release': { read: (r) => r.found_releases.map((x) => String(x.id)), parse: references },
  area: { read: (r) => r.areas.map((x) => String(x.id)), parse: references },
  // Read-only: guards and checks may test them; no layout or effect writes them.
  'time-spent': { read: (r) => r.time_spent },
  'ticket-type': { read: (r) => String(r.ticket_type_id) },
  requester: { read: (r) => idText(r.requester_id) },
  creator: { read: (r) => idText(r.creator_id) },
};

export const isKnownField = (name: string) => Object.hasOwn(WORKFLOW_FIELDS, name);
export const isWritableField = (name: string) => WORKFLOW_FIELDS[name]?.parse !== undefined;

export function parseField(name: string, input: unknown): Parsed {
  const spec = WORKFLOW_FIELDS[name];
  if (!spec?.parse) return bad('not_writable');
  return spec.parse(input);
}

/** The fields the engine reads from a ticket; assignee and close reason live beside them. */
export function engineFields(row: TicketRow): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [name, spec] of Object.entries(WORKFLOW_FIELDS)) {
    if (name === 'assignee' || name === 'close-reason') continue;
    const value = spec.read(row);
    if (value !== null && value !== undefined) out[name] = value;
  }
  return out;
}

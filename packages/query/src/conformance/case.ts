import type { Catalogue } from '../fields';

/**
 * The query-language conformance suite's case format (M1-033). A case is data: query text
 * and what the spec (`docs/specs/01b-core-work-tracking.md`, section 1) says must happen when it
 * is parsed, printed back or resolved against a catalogue. The suite runs against this
 * package's parser and resolver and reports the pass rate per section; a case that fails marks
 * a gap for M1-034 (parser) or M1-035 (compiler), not a wrong case.
 *
 * Provenance: every case cites the QRY requirement it checks and the spec section its behaviour
 * is restated from; the public pages behind those sections are listed in
 * `docs/research/sources.md`. A `verify` note marks a detail the public description leaves open.
 */
export type Section =
  | 'grammar'
  | 'operators'
  | 'fields'
  | 'functions'
  | 'history'
  | 'dates'
  | 'text'
  | 'ordering'
  | 'filters'
  | 'sprints';

export const SECTIONS: readonly Section[] = [
  'grammar',
  'operators',
  'fields',
  'functions',
  'history',
  'dates',
  'text',
  'ordering',
  'filters',
  'sprints',
];

export interface CaseBase {
  /** Unique and stable, starting with the requirement: `QRY-002-ne-number-01`. */
  id: string;
  requirement: `QRY-${string}`;
  section: Section;
  title: string;
  /** Spec section the behaviour is restated from, for example `01b 1.2`. */
  spec: string;
  verify?: string;
}

export type QueryCase = CaseBase &
  (
    | {
        /** The text parses; printed back it reads `canonical`, which parses to the same tree. */
        kind: 'parse';
        text: string;
        expect: { canonical: string };
      }
    | {
        /** The text is refused, with the error pointing at `at` (0-based offset into the text). */
        kind: 'parse-error';
        text: string;
        expect: { at: number; message?: string };
      }
    | {
        /** The text parses and resolves against the catalogue; or resolution refuses it. */
        kind: 'resolve';
        text: string;
        catalogue?: Catalogue;
        expect: { ok: true } | { ok: false; message: string };
      }
    | {
        /** Every text resolves to the same plan (for example both vocabularies). */
        kind: 'equivalent';
        texts: string[];
        catalogue?: Catalogue;
      }
  );

export type CaseKind = QueryCase['kind'];

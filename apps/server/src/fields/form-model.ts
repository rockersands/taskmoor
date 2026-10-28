import { z } from 'zod';

/**
 * The data model of field rules and layouts (M1-012): field names, the layout schema and the
 * sets as the catalogue holds them. Pure and import-free of the catalogue, so `catalog.ts` can
 * load what `layouts.ts` resolves (see `layouts.ts` for the rules).
 */
export const OPERATIONS = ['create', 'edit', 'view'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The system fields rules and layouts govern, in form order, with the body key that writes them. */
export const SYSTEM_FIELDS = [
  { key: 'summary', body: 'summary' },
  { key: 'description', body: 'description' },
  { key: 'environment', body: 'environment' },
  { key: 'assignee', body: 'assigneeId' },
  { key: 'requester', body: 'requesterId' },
  { key: 'parent', body: 'parent' },
  { key: 'priority', body: 'priorityId' },
  { key: 'closeReason', body: 'closeReasonId' },
  { key: 'labels', body: 'labels' },
  { key: 'startDate', body: 'startDate' },
  { key: 'dueDate', body: 'dueDate' },
  { key: 'targetRelease', body: 'targetReleaseIds' },
  { key: 'foundInRelease', body: 'foundInReleaseIds' },
  { key: 'area', body: 'areaIds' },
  { key: 'originalEstimate', body: 'originalEstimate' },
  { key: 'remainingEstimate', body: 'remainingEstimate' },
] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number]['key'];
const SYSTEM_KEYS: ReadonlySet<string> = new Set(SYSTEM_FIELDS.map((f) => f.key));
/** Rules cannot make these optional or hidden. */
export const FIXED_FIELDS: ReadonlySet<string> = new Set(['summary']);

export const customKey = (fieldId: number) => `cf[${fieldId}]`;
const CUSTOM_KEY = /^cf\[([1-9][0-9]{0,9})\]$/;
export function customFieldId(key: string): number | null {
  const m = CUSTOM_KEY.exec(key);
  return m ? Number(m[1]) : null;
}
export const isFieldKey = (key: string) => SYSTEM_KEYS.has(key) || CUSTOM_KEY.test(key);

/** The body key a field is written with, and refused under. */
export function bodyKey(key: string): string {
  const id = customFieldId(key);
  if (id !== null) return `fields.${id}`;
  return SYSTEM_FIELDS.find((f) => f.key === key)?.body ?? key;
}
/** The field a body key writes. */
export function fieldOfBody(body: string): string | null {
  return SYSTEM_FIELDS.find((f) => f.body === body)?.key ?? null;
}

const fieldKey = z.string().refine(isFieldKey, 'a system field name or cf[id]');
export const layoutDefinition = z
  .object({
    tabs: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            sections: z
              .array(
                z
                  .object({
                    /** Main fields, or the context column beside them (CORE-008). */
                    kind: z.enum(['main', 'context']).default('main'),
                    /** Shown only when a field in it has a value (view). */
                    hideWhenEmpty: z.boolean().default(false),
                    fields: z.array(fieldKey).max(500),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict(),
      )
      .max(20),
    /** Whether fields the layout does not place appear after it. */
    others: z.enum(['show', 'omit']).default('show'),
  })
  .strict()
  .refine((d) => {
    const all = d.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields));
    return new Set(all).size === all.length;
  }, 'each field once');
export type LayoutDefinition = z.infer<typeof layoutDefinition>;

export interface RuleDef {
  required: boolean;
  hidden: boolean;
  description: string | null;
}

export interface RuleSetDef {
  id: number;
  trackId: number | null;
  name: string;
  description: string;
  isDefault: boolean;
  /** By `${ticketTypeId ?? 0}|${field}`. */
  rules: ReadonlyMap<string, RuleDef>;
}

export interface LayoutSetDef {
  id: number;
  trackId: number | null;
  name: string;
  description: string;
  isDefault: boolean;
  /** By `${ticketTypeId ?? 0}|${operation}`. */
  layouts: ReadonlyMap<string, LayoutDefinition>;
}

export interface FormConfig {
  ruleSets: ReadonlyMap<number, RuleSetDef>;
  layoutSets: ReadonlyMap<number, LayoutSetDef>;
  defaultRuleSetId: number | null;
  defaultLayoutSetId: number | null;
}

export const EMPTY_FORMS: FormConfig = {
  ruleSets: new Map(),
  layoutSets: new Map(),
  defaultRuleSetId: null,
  defaultLayoutSetId: null,
};

/** Where a ticket sits, and the sets its track uses (null: the workspace's defaults). */
export interface FormPlacement {
  trackId: number;
  ticketTypeId: number;
  ruleSetId: number | null;
  layoutSetId: number | null;
}

import { api } from '../api/client';
import { everyTrack } from '../api/tracks';
import { type TrackScopeClient, trackScopeClient } from '../sets/trackScope';
import {
  findGroups as findFieldGroups,
  findSitePeople,
  findTeams,
  findPeople as findTrackPeople,
  PICKER_LIMIT,
} from '../tickets/pickerSources';

/** The field types an administrator adds from this page, formulas included (T-320). */
export const FIELD_TYPES = [
  'text',
  'paragraph',
  'number',
  'date',
  'datetime',
  'select',
  'cascading-select',
  'user',
  'group',
  'labels',
  'url',
  'read-only-text',
  'release',
  'area',
  'team',
  'formula',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that hold one value or several, chosen when the field is made. */
export const MULTIPLE_TYPES: ReadonlySet<string> = new Set([
  'select',
  'user',
  'group',
  'release',
  'area',
]);
/** Types whose contexts hold options. */
export const OPTION_TYPES: ReadonlySet<string> = new Set(['select', 'cascading-select']);
/**
 * Types whose contexts take no default: a release or an area belongs to one track, read-only
 * text is written by integrations, a formula is computed (the server refuses them).
 */
export const NO_DEFAULT_TYPES: ReadonlySet<string> = new Set([
  'release',
  'area',
  'read-only-text',
  'formula',
]);

export const NUMBER_FORMATS = ['number', 'currency', 'percentage'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];
export const FORMULA_OUTPUTS = [
  'number',
  'currency',
  'percentage',
  'date',
  'duration',
  'text',
] as const;
export type FormulaOutput = (typeof FORMULA_OUTPUTS)[number];
/** Outputs that hold a number, so they take decimals (and currency, a currency code). */
export const NUMBER_OUTPUTS: ReadonlySet<string> = new Set(['number', 'currency', 'percentage']);
/** The most characters a paragraph may be given (the server's `PARAGRAPH_LIMIT`). */
export const PARAGRAPH_LIMIT = 100_000;
/** What a paragraph holds when its field sets no limit. */
export const PARAGRAPH_DEFAULT_MAX = 32_767;

/**
 * A field's type settings, as `config` (CORE-010). `PATCH /fields/:id` replaces them whole, so
 * the page always sends every setting it keeps. The choice-list `display` stays API-only in 1.0:
 * the web app always shows a list, and the page keeps a stored one as it is.
 */
export interface FieldConfig {
  maxChars?: number;
  format?: NumberFormat;
  decimals?: number;
  currency?: string;
  display?: 'dropdown' | 'radio' | 'checkboxes';
  expression?: string;
  output?: FormulaOutput;
}

export interface ChildOption {
  id: number;
  value: string;
  disabled: boolean;
}
export interface FieldOption extends ChildOption {
  children?: ChildOption[];
}

/** Whom a person field's context offers (CORE-009 (2)): a group's members or a role's holders. */
export interface ContextConfig {
  userGroupId?: number;
  userRoleId?: number;
}

export interface FieldContext {
  id: number;
  name: string;
  description?: string;
  /** The tracks and ticket types it covers; null for every one. */
  trackIds: number[] | null;
  ticketTypeIds: number[] | null;
  config?: ContextConfig;
  /**
   * The value a new ticket starts with, as REST shows a value: options and people with their
   * names (`{ id, value }`), several of them, or a two-level list's pair with its `child`; null
   * for none. `defaultOptionIds` (defaultValue.ts) reads the options it names.
   */
  defaultValue?: unknown;
  options?: FieldOption[];
}

/** A custom field as `GET /api/v1/fields` and `/fields/:id` show it. */
export interface Field {
  id: number;
  name: string;
  description: string;
  type: FieldType;
  multiple: boolean;
  config?: FieldConfig;
  trackId: number | null;
  contexts: FieldContext[];
}

/** Where a formula is wrong (CORE-011 (3)): its code and the span at fault, lines from 1. */
export interface FormulaProblem {
  code: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

/** What `GET /api/v1/formulas/check` answers while a formula is typed. */
export type FormulaCheck =
  | { ok: true; type: string; reads: string[]; childReads: string[] }
  | { ok: false; error: FormulaProblem };

export interface Named {
  id: number;
  name: string;
}
export interface NamedTrack extends Named {
  key: string;
}

export interface ContextBody {
  name: string;
  trackIds: number[] | null;
  ticketTypeIds: number[] | null;
  config?: { userGroupId?: number | null; userRoleId?: number | null };
}

/** The endpoints the fields page uses. Stories and tests pass their own. */
export interface FieldsClient extends TrackScopeClient {
  /**
   * Every field the caller may read; with a track, the shared fields that reach it and the ones it
   * owns (T-322).
   */
  fields: (trackId?: number) => Promise<Field[]>;
  field: (id: number) => Promise<Field>;
  createField: (body: {
    name: string;
    type: FieldType;
    description?: string;
    multiple?: boolean;
    config?: FieldConfig;
    /** A local-mode track that owns the field (T-322); shared when left out. */
    trackId?: number;
  }) => Promise<Field>;
  updateField: (
    id: number,
    change: { name?: string; description?: string; config?: FieldConfig },
  ) => Promise<Field>;
  deleteField: (id: number) => Promise<void>;
  addContext: (fieldId: number, body: ContextBody) => Promise<Field>;
  updateContext: (
    fieldId: number,
    contextId: number,
    change: Partial<ContextBody> & { defaultValue?: unknown },
  ) => Promise<Field>;
  deleteContext: (fieldId: number, contextId: number) => Promise<void>;
  /** A top-level option, or with `parentId` a child option of a two-level list. */
  addOption: (
    fieldId: number,
    contextId: number,
    value: string,
    parentId?: number,
  ) => Promise<Field>;
  updateOption: (
    fieldId: number,
    contextId: number,
    optionId: number,
    change: { value?: string; disabled?: boolean },
  ) => Promise<Field>;
  deleteOption: (fieldId: number, contextId: number, optionId: number) => Promise<void>;
  /** Every option at one level (`parentId` null: the top), in the new order. */
  orderOptions: (
    fieldId: number,
    contextId: number,
    parentId: number | null,
    optionIds: number[],
  ) => Promise<Field>;
  checkFormula: (query: {
    expression: string;
    output: FormulaOutput;
    fieldId?: number;
    trackId?: number;
  }) => Promise<FormulaCheck>;
  /** The lists a context chooses from: tracks, ticket types (a track's own too), groups, roles. */
  tracks: () => Promise<NamedTrack[]>;
  ticketTypes: (trackId: number | null) => Promise<Named[]>;
  groups: () => Promise<Named[]>;
  roles: () => Promise<Named[]>;
  /** People and teams by name, for a default value. */
  findPeople: (typed: string) => Promise<Named[]>;
  findTeams: (typed: string) => Promise<Named[]>;
  /**
   * The groups a group field's default may name, by name: the site's list (`GET /groups`), which
   * site and configuration administrators may always read.
   */
  findGroups: (fieldId: number, typed: string) => Promise<Named[]>;
  /** What a local-mode track's runners read instead of the site's lists (T-322). */
  trackRoles: (trackId: number) => Promise<Named[]>;
  findTrackPeople: (trackKey: string, typed: string) => Promise<Named[]>;
  /** The same groups through the field (`GET /fields/:id/groups`, Browse users and groups). */
  findFieldGroups: (fieldId: number, typed: string) => Promise<Named[]>;
}

const optionPath = (fieldId: number, contextId: number) =>
  `/fields/${fieldId}/contexts/${contextId}/options`;
const named = (rows: Named[]) => rows.map(({ id, name }) => ({ id, name }));

export const fieldsClient: FieldsClient = {
  ...trackScopeClient,
  fields: async (trackId) =>
    (
      await api<{ fields: Field[] }>(
        trackId === undefined ? '/fields' : `/fields?trackId=${trackId}`,
      )
    ).fields,
  field: async (id) => (await api<{ field: Field }>(`/fields/${id}`)).field,
  createField: async (body) =>
    (await api<{ field: Field }>('/fields', { method: 'POST', body })).field,
  updateField: async (id, change) =>
    (await api<{ field: Field }>(`/fields/${id}`, { method: 'PATCH', body: change })).field,
  deleteField: async (id) => {
    await api<unknown>(`/fields/${id}`, { method: 'DELETE' });
  },
  addContext: async (fieldId, body) =>
    (await api<{ field: Field }>(`/fields/${fieldId}/contexts`, { method: 'POST', body })).field,
  updateContext: async (fieldId, contextId, change) =>
    (
      await api<{ field: Field }>(`/fields/${fieldId}/contexts/${contextId}`, {
        method: 'PATCH',
        body: change,
      })
    ).field,
  deleteContext: async (fieldId, contextId) => {
    await api<unknown>(`/fields/${fieldId}/contexts/${contextId}`, { method: 'DELETE' });
  },
  addOption: async (fieldId, contextId, value, parentId) =>
    (
      await api<{ field: Field }>(optionPath(fieldId, contextId), {
        method: 'POST',
        body: parentId === undefined ? { value } : { value, parentId },
      })
    ).field,
  updateOption: async (fieldId, contextId, optionId, change) =>
    (
      await api<{ field: Field }>(`${optionPath(fieldId, contextId)}/${optionId}`, {
        method: 'PATCH',
        body: change,
      })
    ).field,
  deleteOption: async (fieldId, contextId, optionId) => {
    await api<unknown>(`${optionPath(fieldId, contextId)}/${optionId}`, { method: 'DELETE' });
  },
  orderOptions: async (fieldId, contextId, parentId, optionIds) =>
    (
      await api<{ field: Field }>(`${optionPath(fieldId, contextId)}/order`, {
        method: 'PUT',
        body: { parentId, optionIds },
      })
    ).field,
  checkFormula: async ({ expression, output, fieldId, trackId }) => {
    const query = new URLSearchParams({ expression, output });
    if (fieldId !== undefined) query.set('fieldId', String(fieldId));
    if (trackId !== undefined) query.set('trackId', String(trackId));
    return api<FormulaCheck>(`/formulas/check?${query}`);
  },
  tracks: async () =>
    (await everyTrack<NamedTrack>('archived=include')).map(({ id, key, name }) => ({
      id,
      key,
      name,
    })),
  ticketTypes: async (trackId) =>
    named(
      (
        await api<{ ticketTypes: Named[] }>(
          trackId === null ? '/ticket-types' : `/ticket-types?trackId=${trackId}`,
        )
      ).ticketTypes,
    ),
  groups: async () => named((await api<{ groups: Named[] }>('/groups')).groups),
  roles: async () => named((await api<{ roles: Named[] }>('/roles')).roles),
  findPeople: findSitePeople,
  findTeams,
  findGroups: async (_fieldId, typed) =>
    named(
      (await api<{ groups: Named[] }>(`/groups?query=${encodeURIComponent(typed)}`)).groups,
    ).slice(0, PICKER_LIMIT),
  trackRoles: async (trackId) =>
    named((await api<{ roles: Named[] }>(`/tracks/${trackId}/roles`)).roles),
  findTrackPeople: (trackKey, typed) => findTrackPeople(trackKey, typed),
  findFieldGroups,
};

/**
 * The client of a local-mode track's own Fields page (T-322; T-163a's pattern): the fields that
 * reach the track, new fields the track owns, and the track alone as the list of tracks, since its
 * fields cover it only. Site and configuration administrators keep the site's lists of groups,
 * roles and people. Anyone else, who runs the track, reads only what that lets them read: the
 * roles from the track's own list, people who may be mentioned in it, and no groups, whose list is
 * for administrators; a group field's default finds groups by name through the field instead.
 */
export function trackFieldsClient(
  client: FieldsClient,
  track: NamedTrack,
  admin: boolean,
): FieldsClient {
  return {
    ...client,
    fields: () => client.fields(track.id),
    createField: (body) => client.createField({ ...body, trackId: track.id }),
    tracks: async () => [{ id: track.id, key: track.key, name: track.name }],
    ...(admin
      ? {}
      : {
          groups: async () => [],
          roles: () => client.trackRoles(track.id),
          findPeople: (typed: string) => client.findTrackPeople(track.key, typed),
          findGroups: (fieldId: number, typed: string) => client.findFieldGroups(fieldId, typed),
        }),
  };
}

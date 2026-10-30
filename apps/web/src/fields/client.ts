import { api } from '../api/client';

/** The field types an administrator adds from this page; formulas need their own editor. */
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
] as const;
export type FieldType = (typeof FIELD_TYPES)[number] | 'formula';

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

export interface FieldOption {
  id: number;
  value: string;
  disabled: boolean;
  children?: { id: number; value: string; disabled: boolean }[];
}

export interface FieldContext {
  id: number;
  name: string;
  trackIds: number[] | null;
  ticketTypeIds: number[] | null;
  options?: FieldOption[];
}

/** A custom field as `GET /api/v1/fields` and `/fields/:id` show it. */
export interface Field {
  id: number;
  name: string;
  description: string;
  type: FieldType;
  multiple: boolean;
  trackId: number | null;
  contexts: FieldContext[];
}

/** The endpoints the fields page uses. Stories and tests pass their own. */
export interface FieldsClient {
  fields: () => Promise<Field[]>;
  field: (id: number) => Promise<Field>;
  createField: (body: { name: string; type: FieldType; multiple?: boolean }) => Promise<Field>;
  updateField: (id: number, change: { name?: string; description?: string }) => Promise<Field>;
  deleteField: (id: number) => Promise<void>;
  addOption: (fieldId: number, contextId: number, value: string) => Promise<Field>;
  updateOption: (
    fieldId: number,
    contextId: number,
    optionId: number,
    change: { value?: string; disabled?: boolean },
  ) => Promise<Field>;
  deleteOption: (fieldId: number, contextId: number, optionId: number) => Promise<void>;
}

const optionPath = (fieldId: number, contextId: number) =>
  `/fields/${fieldId}/contexts/${contextId}/options`;

export const fieldsClient: FieldsClient = {
  fields: async () => (await api<{ fields: Field[] }>('/fields')).fields,
  field: async (id) => (await api<{ field: Field }>(`/fields/${id}`)).field,
  createField: async (body) =>
    (await api<{ field: Field }>('/fields', { method: 'POST', body })).field,
  updateField: async (id, change) =>
    (await api<{ field: Field }>(`/fields/${id}`, { method: 'PATCH', body: change })).field,
  deleteField: async (id) => {
    await api<unknown>(`/fields/${id}`, { method: 'DELETE' });
  },
  addOption: async (fieldId, contextId, value) =>
    (
      await api<{ field: Field }>(optionPath(fieldId, contextId), {
        method: 'POST',
        body: { value },
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
};

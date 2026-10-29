import { ApiError } from '../api/client';
import type { Field, FieldsClient } from './client';

export interface FakeFieldsClient extends FieldsClient {
  calls: { action: string; args: unknown[] }[];
}

/**
 * An in-memory backend for stories and tests: it answers as the API would. Medium is on three
 * tickets, so deleting it, or the field, is refused.
 */
export function fakeFieldsClient(): FakeFieldsClient {
  let fields: Field[] = [
    {
      id: 1,
      name: 'Customer',
      description: '',
      type: 'text',
      multiple: false,
      trackId: null,
      contexts: [{ id: 10, name: 'Everywhere', trackIds: null, ticketTypeIds: null }],
    },
    {
      id: 2,
      name: 'Severity',
      description: '',
      type: 'select',
      multiple: false,
      trackId: null,
      contexts: [
        {
          id: 20,
          name: 'Everywhere',
          trackIds: null,
          ticketTypeIds: null,
          options: [
            { id: 201, value: 'Low', disabled: false, children: [] },
            { id: 202, value: 'Medium', disabled: false, children: [] },
            { id: 203, value: 'Critical', disabled: true, children: [] },
          ],
        },
      ],
    },
    {
      id: 3,
      name: 'Components',
      description: '',
      type: 'select',
      multiple: true,
      trackId: 4,
      contexts: [{ id: 30, name: 'OPS', trackIds: [4], ticketTypeIds: null, options: [] }],
    },
  ];
  const inUse = new Set([202]);
  let next = 1000;
  const calls: FakeFieldsClient['calls'] = [];
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  const find = (id: number) => fields.find((f) => f.id === id) as Field;
  const options = (fieldId: number, contextId: number) => {
    const context = find(fieldId).contexts.find((c) => c.id === contextId);
    if (!context) throw new ApiError(404, { error: 'not_found' });
    context.options ??= [];
    return context.options;
  };
  return {
    calls,
    fields: async () =>
      structuredClone(fields).map((f) => ({
        ...f,
        contexts: f.contexts.map(({ options: _, ...c }) => c),
      })),
    field: async (id) => structuredClone(find(id)),
    createField: async (body) => {
      log('createField', body);
      if (fields.some((f) => f.name === body.name))
        throw new ApiError(409, { error: 'name_taken' });
      const made: Field = {
        id: ++next,
        name: body.name,
        description: '',
        type: body.type,
        multiple: body.multiple ?? false,
        trackId: null,
        contexts: [
          {
            id: ++next,
            name: 'Everywhere',
            trackIds: null,
            ticketTypeIds: null,
            ...(body.type === 'select' || body.type === 'cascading-select' ? { options: [] } : {}),
          },
        ],
      };
      fields = [...fields, made];
      return structuredClone(made);
    },
    updateField: async (id, change) => {
      log('updateField', id, change);
      Object.assign(find(id), change);
      return structuredClone(find(id));
    },
    deleteField: async (id) => {
      log('deleteField', id);
      const held = find(id).contexts.some((c) => (c.options ?? []).some((o) => inUse.has(o.id)));
      if (held) throw new ApiError(409, { error: 'in_use', ticketCount: 3 });
      fields = fields.filter((f) => f.id !== id);
    },
    addOption: async (fieldId, contextId, value) => {
      log('addOption', fieldId, contextId, value);
      const list = options(fieldId, contextId);
      if (list.some((o) => o.value === value)) throw new ApiError(409, { error: 'value_taken' });
      list.push({ id: ++next, value, disabled: false, children: [] });
      return structuredClone(find(fieldId));
    },
    updateOption: async (fieldId, contextId, optionId, change) => {
      log('updateOption', fieldId, contextId, optionId, change);
      Object.assign(options(fieldId, contextId).find((o) => o.id === optionId) ?? {}, change);
      return structuredClone(find(fieldId));
    },
    deleteOption: async (fieldId, contextId, optionId) => {
      log('deleteOption', fieldId, contextId, optionId);
      if (inUse.has(optionId)) throw new ApiError(409, { error: 'in_use', ticketCount: 3 });
      const list = options(fieldId, contextId);
      list.splice(
        list.findIndex((o) => o.id === optionId),
        1,
      );
    },
  };
}

/**
 * What a query can refer to. System fields map to item columns; custom fields live in typed
 * side tables (ADR-008). Names are matched without regard to case; aliases keep the
 * Jira-compatible vocabulary working (`project`, `issuetype`, `fixVersion`, ...).
 */
export type SystemType =
  | 'key'
  | 'number'
  | 'text'
  | 'datetime'
  | 'user'
  | 'labels'
  | 'space'
  | 'status'
  | 'statusCategory'
  | 'priority'
  | 'itemType';

export type CustomType = 'text' | 'number' | 'date' | 'user' | 'option' | 'multi' | 'labels';

export interface SystemField {
  kind: 'system';
  name: string;
  aliases: readonly string[];
  type: SystemType;
  /** Column on the item table. */
  column: string;
  /** Name used in the change history for WAS and CHANGED. */
  history?: string;
  /** The column may be null (sorting then puts empties last). */
  nullable?: boolean;
}

export interface CustomField {
  kind: 'custom';
  id: number;
  name: string;
  type: CustomType;
}

export type Field = SystemField | CustomField;

export interface Catalogue {
  systems: readonly SystemField[];
  customs: readonly CustomField[];
  /** Space key to ID, so `project = ABC` becomes a number. */
  spaceKeys: Readonly<Record<string, number>>;
}

export const SYSTEM_FIELDS: readonly SystemField[] = [
  { kind: 'system', name: 'id', aliases: [], type: 'number', column: 'id' },
  { kind: 'system', name: 'key', aliases: ['issuekey', 'issue'], type: 'key', column: 'key' },
  { kind: 'system', name: 'space', aliases: ['project'], type: 'space', column: 'space_id' },
  {
    kind: 'system',
    name: 'type',
    aliases: ['issuetype', 'worktype'],
    type: 'itemType',
    column: 'type',
  },
  {
    kind: 'system',
    name: 'status',
    aliases: [],
    type: 'status',
    column: 'status',
    history: 'status',
  },
  {
    kind: 'system',
    name: 'statusCategory',
    aliases: [],
    type: 'statusCategory',
    column: 'status_category',
  },
  {
    kind: 'system',
    name: 'priority',
    aliases: [],
    type: 'priority',
    column: 'priority',
    history: 'priority',
  },
  {
    kind: 'system',
    name: 'summary',
    aliases: ['title'],
    type: 'text',
    column: 'summary',
    history: 'summary',
  },
  {
    kind: 'system',
    name: 'description',
    aliases: [],
    type: 'text',
    column: 'description',
    nullable: true,
  },
  {
    kind: 'system',
    name: 'assignee',
    aliases: [],
    type: 'user',
    column: 'assignee_id',
    nullable: true,
    history: 'assignee',
  },
  { kind: 'system', name: 'reporter', aliases: [], type: 'user', column: 'reporter_id' },
  { kind: 'system', name: 'labels', aliases: ['label'], type: 'labels', column: 'labels' },
  {
    kind: 'system',
    name: 'parent',
    aliases: [],
    type: 'number',
    column: 'parent_id',
    nullable: true,
  },
  {
    kind: 'system',
    name: 'created',
    aliases: ['createdDate'],
    type: 'datetime',
    column: 'created_at',
  },
  {
    kind: 'system',
    name: 'updated',
    aliases: ['updatedDate'],
    type: 'datetime',
    column: 'updated_at',
  },
  {
    kind: 'system',
    name: 'resolved',
    aliases: ['resolutionDate'],
    type: 'datetime',
    column: 'resolved_at',
    nullable: true,
  },
];

export function makeCatalogue(
  customs: readonly CustomField[] = [],
  spaceKeys: Readonly<Record<string, number>> = {},
): Catalogue {
  return { systems: SYSTEM_FIELDS, customs, spaceKeys };
}

/** Finds a field by name or alias (any case) or by custom field number. */
export function lookupField(
  catalogue: Catalogue,
  ref: { name: string; custom?: number },
): Field | undefined {
  if (ref.custom !== undefined) return catalogue.customs.find((f) => f.id === ref.custom);
  const wanted = ref.name.toLowerCase();
  const system = catalogue.systems.find(
    (f) => f.name.toLowerCase() === wanted || f.aliases.some((a) => a.toLowerCase() === wanted),
  );
  if (system) return system;
  return catalogue.customs.find((f) => f.name.toLowerCase() === wanted);
}

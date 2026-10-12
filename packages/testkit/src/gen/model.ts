/** Shapes of the synthetic dataset. Neutral on purpose: spikes map them onto candidate schemas. */

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'user' | 'labels';
export type FieldValue = string | number | string[];
export type ItemType = 'Epic' | 'Story' | 'Task' | 'Bug' | 'Subtask';
export type StatusCategory = 'todo' | 'in_progress' | 'done';
export type Priority = 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
export type SpaceType = 'software' | 'business' | 'service';

export interface GenUser {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export interface GenSpace {
  id: number;
  key: string;
  name: string;
  type: SpaceType;
  leadId: number;
}

export interface GenField {
  id: number;
  name: string;
  type: FieldType;
  /** Choices for select, multiselect; empty otherwise. */
  options: string[];
  /** Null for site-wide fields; a space ID for space-local ones. */
  spaceId: number | null;
}

export interface GenItem {
  id: number;
  spaceId: number;
  /** Sequential per space: KEY-1, KEY-2, ... */
  number: number;
  key: string;
  type: ItemType;
  parentId: number | null;
  status: string;
  statusCategory: StatusCategory;
  priority: Priority;
  summary: string;
  description: string | null;
  reporterId: number;
  assigneeId: number | null;
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  /** Custom field values keyed by field ID. User fields hold a user ID. */
  fields: Record<string, FieldValue>;
}

export interface GenHistory {
  itemId: number;
  at: Date;
  actorId: number;
  field: string;
  from: string | null;
  to: string | null;
}

export interface GenConfig {
  seed: number;
  users: number;
  spaces: number;
  fields: number;
  items: number;
  /** Share of fields that belong to one space instead of the whole site. */
  spaceLocalFieldShare: number;
  /** Average number of custom fields with a value on one item. */
  fieldsPerItem: number;
  /** Average number of history entries per item. */
  historyPerItem: number;
  start: Date;
  end: Date;
}

/** Short size label for names: 1000 -> 1k, 1000000 -> 1m, 2500000 -> 2500k, 12 -> 12. */
export function sizeLabel(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}m`;
  if (n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

/** Sensible proportions for a given item count, matching the 1M, 10M and 30M benchmark tiers. */
export function scaleConfig(items: number, overrides: Partial<GenConfig> = {}): GenConfig {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  return {
    seed: 20261012,
    users: clamp(items / 200, 20, 50_000),
    spaces: clamp(items / 5_000, 3, 5_000),
    fields: items >= 100_000 ? 1_500 : clamp(items / 50, 10, 1_500),
    items,
    spaceLocalFieldShare: 0.3,
    fieldsPerItem: 25,
    historyPerItem: 6,
    start: new Date('2018-01-01T00:00:00Z'),
    end: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

import type {
  FieldType,
  FieldValue,
  GenConfig,
  GenField,
  GenHistory,
  GenItem,
  GenSpace,
  GenUser,
  ItemType,
  Priority,
  SpaceType,
  StatusCategory,
} from './model';
import { Rng, ZipfSampler } from './rng';
import { LABEL_STEMS, NOUNS, QUALIFIERS, SENTENCES, SYLLABLES, VERBS } from './words';

const DAY = 86_400_000;

const STATUSES: Record<StatusCategory, readonly string[]> = {
  todo: ['Backlog', 'To Do', 'Selected'],
  in_progress: ['In Progress', 'In Review', 'Blocked'],
  done: ['Done', 'Closed', "Won't Do"],
};
const PRIORITIES: readonly (readonly [Priority, number])[] = [
  ['Highest', 3],
  ['High', 15],
  ['Medium', 60],
  ['Low', 17],
  ['Lowest', 5],
];
const ITEM_TYPES: readonly (readonly [ItemType, number])[] = [
  ['Epic', 4],
  ['Story', 35],
  ['Task', 30],
  ['Bug', 21],
  ['Subtask', 10],
];
const FIELD_TYPES: readonly (readonly [FieldType, number])[] = [
  ['text', 25],
  ['number', 15],
  ['date', 10],
  ['select', 25],
  ['multiselect', 10],
  ['user', 10],
  ['labels', 5],
];
const SPACE_TYPES: readonly (readonly [SpaceType, number])[] = [
  ['software', 60],
  ['business', 25],
  ['service', 15],
];

function word(rng: Rng, syllables: number): string {
  let w = '';
  for (let i = 0; i < syllables; i++) w += rng.pick(SYLLABLES);
  return w;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Space keys in spreadsheet-column style starting at two letters: AA, AB, ..., ZZ, AAA, ... */
export function spaceKey(index: number): string {
  let n = index + 27;
  let key = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    key = String.fromCharCode(65 + r) + key;
    n = Math.floor((n - 1) / 26);
  }
  return key;
}

export function generateUsers(cfg: GenConfig): GenUser[] {
  return Array.from({ length: cfg.users }, (_, i) => {
    const rng = Rng.derive(cfg.seed, 'user', i);
    const first = capitalise(word(rng, rng.int(1, 2)));
    const last = capitalise(word(rng, rng.int(2, 3)));
    return {
      id: i + 1,
      name: `${first} ${last}`,
      email: `${first}.${last}.${i + 1}@example.test`.toLowerCase(),
      active: rng.chance(0.95),
    };
  });
}

export function generateSpaces(cfg: GenConfig): GenSpace[] {
  const leads = new ZipfSampler(cfg.users);
  return Array.from({ length: cfg.spaces }, (_, i) => {
    const rng = Rng.derive(cfg.seed, 'space', i);
    return {
      id: i + 1,
      key: spaceKey(i),
      name: `${capitalise(word(rng, 2))} ${rng.pick(['Platform', 'Team', 'Ops', 'Web', 'Support', 'Growth', 'Core'])}`,
      type: rng.weighted(SPACE_TYPES),
      leadId: leads.sample(rng) + 1,
    };
  });
}

export function generateFields(cfg: GenConfig): GenField[] {
  const spaces = new ZipfSampler(cfg.spaces);
  return Array.from({ length: cfg.fields }, (_, i) => {
    const rng = Rng.derive(cfg.seed, 'field', i);
    const type = rng.weighted(FIELD_TYPES);
    const options =
      type === 'select' || type === 'multiselect'
        ? Array.from({ length: rng.int(2, 30) }, (_, o) => `${capitalise(word(rng, 2))} ${o + 1}`)
        : [];
    const local = rng.chance(cfg.spaceLocalFieldShare);
    return {
      id: i + 1,
      name: `${capitalise(word(rng, 2))} ${type} ${i + 1}`,
      type,
      options,
      spaceId: local ? spaces.sample(rng) + 1 : null,
    };
  });
}

/** Fixed-size buffer of recent IDs; enough to pick plausible parents without unbounded memory. */
class Recent {
  private readonly ids: number[] = [];
  private next = 0;
  constructor(private readonly capacity: number) {}
  add(id: number): void {
    if (this.ids.length < this.capacity) this.ids.push(id);
    else this.ids[this.next] = id;
    this.next = (this.next + 1) % this.capacity;
  }
  pick(rng: Rng): number | undefined {
    return this.ids.length === 0 ? undefined : rng.pick(this.ids);
  }
}

export interface Dataset {
  config: GenConfig;
  users: GenUser[];
  spaces: GenSpace[];
  fields: GenField[];
  /** Streams items in ID order with their history; call again to restart from the beginning. */
  items(): Generator<{ item: GenItem; history: GenHistory[] }>;
}

export function createDataset(cfg: GenConfig): Dataset {
  const users = generateUsers(cfg);
  const spaces = generateSpaces(cfg);
  const fields = generateFields(cfg);

  const globalFields = fields.filter((f) => f.spaceId === null);
  const localBySpace = new Map<number, GenField[]>();
  for (const f of fields) {
    if (f.spaceId !== null) {
      const list = localBySpace.get(f.spaceId) ?? [];
      list.push(f);
      localBySpace.set(f.spaceId, list);
    }
  }
  const applicable = (spaceId: number): GenField[] => [
    ...globalFields,
    ...(localBySpace.get(spaceId) ?? []),
  ];

  function* items(): Generator<{ item: GenItem; history: GenHistory[] }> {
    const spaceSampler = new ZipfSampler(cfg.spaces);
    const userSampler = new ZipfSampler(cfg.users);
    const counters = new Int32Array(cfg.spaces);
    const parents = Array.from({ length: cfg.spaces }, () => new Recent(200));
    const epics = Array.from({ length: cfg.spaces }, () => new Recent(50));
    const fieldCache = new Map<number, GenField[]>();
    const start = cfg.start.getTime();
    const end = cfg.end.getTime();
    const span = end - start;

    for (let i = 0; i < cfg.items; i++) {
      const rng = Rng.derive(cfg.seed, 'item', i);
      const id = i + 1;
      const spaceIndex = spaceSampler.sample(rng);
      const space = spaces[spaceIndex] as GenSpace;
      const number = (counters[spaceIndex] ?? 0) + 1;
      counters[spaceIndex] = number;

      let type = rng.weighted(ITEM_TYPES);
      let parentId: number | null = null;
      if (type === 'Subtask') {
        const p = parents[spaceIndex]?.pick(rng);
        if (p === undefined) type = 'Task';
        else parentId = p;
      } else if (type !== 'Epic' && rng.chance(0.35)) {
        parentId = epics[spaceIndex]?.pick(rng) ?? null;
      }
      if (type === 'Epic') epics[spaceIndex]?.add(id);
      if (type !== 'Subtask') parents[spaceIndex]?.add(id);

      const createdAt = new Date(start + ((i + rng.next()) / cfg.items) * span);
      const updatedAt = new Date(Math.min(end, createdAt.getTime() + rng.exponential(20 * DAY)));
      const age = 1 - i / cfg.items;
      const statusCategory: StatusCategory = rng.weighted([
        ['todo', 0.5 - 0.35 * age],
        ['in_progress', 0.2],
        ['done', 0.3 + 0.6 * age],
      ]);
      const reporterId = userSampler.sample(rng) + 1;
      const assigneeId = rng.chance(0.85) ? userSampler.sample(rng) + 1 : null;

      const labels = new Set<string>();
      const labelCount = Math.min(4, rng.geometric(0.8));
      for (let l = 0; l < labelCount; l++) labels.add(rng.pick(LABEL_STEMS));

      const qualifier = rng.pick(QUALIFIERS);
      const summary = `${rng.pick(VERBS)} ${rng.pick(NOUNS)}${qualifier ? ` ${qualifier}` : ''}`;
      const description = rng.chance(0.65)
        ? Array.from({ length: rng.int(1, 6) }, () => rng.pick(SENTENCES)).join(' ')
        : null;

      let candidates = fieldCache.get(space.id);
      if (!candidates) {
        candidates = applicable(space.id);
        fieldCache.set(space.id, candidates);
      }
      const values: Record<string, FieldValue> = {};
      const wanted = Math.min(
        candidates.length,
        rng.int(Math.floor(cfg.fieldsPerItem * 0.5), Math.ceil(cfg.fieldsPerItem * 1.5)),
      );
      for (let tries = 0; Object.keys(values).length < wanted && tries < wanted * 4; tries++) {
        const field = rng.pick(candidates);
        if (String(field.id) in values) continue;
        values[String(field.id)] = fieldValue(rng, field, userSampler, createdAt.getTime(), end);
      }

      const item: GenItem = {
        id,
        spaceId: space.id,
        number,
        key: `${space.key}-${number}`,
        type,
        parentId,
        status: rng.pick(STATUSES[statusCategory]),
        statusCategory,
        priority: rng.weighted(PRIORITIES),
        summary,
        description,
        reporterId,
        assigneeId,
        labels: [...labels],
        createdAt,
        updatedAt,
        resolvedAt: statusCategory === 'done' ? updatedAt : null,
        fields: values,
      };
      yield { item, history: history(rng, item, cfg, userSampler) };
    }
  }

  return { config: cfg, users, spaces, fields, items };
}

function fieldValue(
  rng: Rng,
  field: GenField,
  users: ZipfSampler,
  from: number,
  to: number,
): FieldValue {
  switch (field.type) {
    case 'text':
      return `${rng.pick(NOUNS)} ${rng.int(1, 999)}`;
    case 'number':
      return Math.round(rng.next() * 100_000) / 100;
    case 'date':
      return new Date(from + rng.next() * Math.max(0, to - from)).toISOString().slice(0, 10);
    case 'select':
      return rng.pick(field.options);
    case 'multiselect': {
      const chosen = new Set<string>();
      const count = rng.int(1, Math.min(3, field.options.length));
      while (chosen.size < count) chosen.add(rng.pick(field.options));
      return [...chosen];
    }
    case 'user':
      return users.sample(rng) + 1;
    case 'labels': {
      const chosen = new Set<string>();
      const count = rng.int(1, 3);
      while (chosen.size < count) chosen.add(rng.pick(LABEL_STEMS));
      return [...chosen];
    }
  }
}

function history(rng: Rng, item: GenItem, cfg: GenConfig, users: ZipfSampler): GenHistory[] {
  const count = rng.geometric(cfg.historyPerItem);
  if (count === 0) return [];
  const from = item.createdAt.getTime();
  const span = item.updatedAt.getTime() - from;
  const times = Array.from({ length: count }, () => from + rng.next() * span).sort((a, b) => a - b);
  const customIds = Object.keys(item.fields);
  return times.map((t) => {
    const field = rng.weighted<string>([
      ['status', 40],
      ['assignee', 25],
      ['priority', 10],
      ['summary', 5],
      ['custom', customIds.length > 0 ? 20 : 0],
    ]);
    const name = field === 'custom' ? `cf:${rng.pick(customIds)}` : field;
    return {
      itemId: item.id,
      at: new Date(t),
      actorId: users.sample(rng) + 1,
      field: name,
      from: field === 'assignee' ? String(users.sample(rng) + 1) : `${field} ${rng.int(1, 9)}`,
      to: field === 'status' ? item.status : `${field} ${rng.int(1, 9)}`,
    };
  });
}

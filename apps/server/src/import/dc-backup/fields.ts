import {
  type CustomFieldType,
  customFieldKey,
  type SCREEN_OPERATIONS,
  SYSTEM_FIELD_TYPES,
} from './format';
import { Random } from './random';
import {
  between,
  FIRST_ID,
  type IssueFacts,
  type IssueType,
  type Person,
  type Project,
  paragraphs,
  type World,
  words,
} from './world';

/**
 * The synthetic instance's custom fields and form configuration (M1-089): custom fields with
 * their contexts (a field configuration scheme each, scoped to projects and issue types) and
 * options, default values, field configurations (required, hidden, help text) in field
 * configuration schemes, and screens with tabs in screen schemes and issue type screen schemes,
 * each tied to projects. Everything here is fixed by the world's projects and types; each
 * issue's values come from their own seed stream (`customValues`), so any pass recomputes them.
 * This is the format layer, in the format's own vocabulary (ADR-003); names are invented.
 */

const DAY = 86_400_000;

/** A built-in type, or a plugin's type the importer does not know. */
export type FieldKind = CustomFieldType | 'plugin';

export interface OptionDef {
  id: number;
  value: string;
  sequence: number;
  disabled: boolean;
  /** A cascading select's child names its parent option. */
  parent: number | null;
}

export interface ContextDef {
  /** The field configuration scheme (the context) and its one field configuration. */
  id: number;
  configId: number;
  name: string;
  description: string;
  /** Project ids, or null for every project. */
  projects: number[] | null;
  /** Issue type ids, or null for every type. */
  types: number[] | null;
  options: OptionDef[];
  /** The default value: options (a select) or a number. */
  defaultOption: number | null;
  defaultNumber: number | null;
}

export interface FieldDef {
  id: number;
  name: string;
  description: string;
  kind: FieldKind;
  typeKey: string;
  searcherKey: string | null;
  /** Chance that an issue in one of the field's contexts has a value. */
  rate: number;
  contexts: ContextDef[];
}

export interface LayoutItemDef {
  field: string;
  required: boolean;
  hidden: boolean;
  description: string | null;
}

export interface FieldLayoutDef {
  id: number;
  name: string;
  description: string;
  /** The field configuration projects without a scheme use. */
  isDefault: boolean;
  items: LayoutItemDef[];
}

export interface FieldLayoutSchemeDef {
  id: number;
  name: string;
  description: string;
  /** Issue type (null: every other type) to field configuration. */
  entities: { type: number | null; layout: number }[];
}

export interface ScreenDef {
  id: number;
  name: string;
  description: string;
  tabs: { name: string; fields: string[] }[];
}

export type ScreenOperation = keyof typeof SCREEN_OPERATIONS;

export interface ScreenSchemeDef {
  id: number;
  name: string;
  description: string;
  /** Operation (null: the default screen) to screen. */
  items: { operation: ScreenOperation | null; screen: number }[];
}

export interface TypeScreenSchemeDef {
  id: number;
  name: string;
  description: string;
  entities: { type: number | null; screenScheme: number }[];
}

export interface FieldWorld {
  fields: FieldDef[];
  layouts: FieldLayoutDef[];
  layoutSchemes: FieldLayoutSchemeDef[];
  screens: ScreenDef[];
  screenSchemes: ScreenSchemeDef[];
  typeScreenSchemes: TypeScreenSchemeDef[];
  /** Project id to its field configuration scheme; projects without one use the default. */
  layoutSchemeOf: Map<number, number>;
  /** Project id to its issue type screen scheme. */
  typeScreenSchemeOf: Map<number, number>;
}

// biome-ignore format: a word list
const TOPICS = [
  'billing-flow', 'onboarding', 'search-ui', 'exports', 'reliability', 'pricing', 'mobile-app',
  'partner-api', 'accessibility', 'data-quality',
];

/** The fields' fixed definitions; contexts and options get their ids when the world is built. */
interface FieldSpec {
  name: string;
  description: string;
  kind: FieldKind;
  rate: number;
  contexts: {
    name: string;
    projects: 'all' | 'software' | 'first';
    types: string[] | null;
    options?: (string | { value: string; disabled?: true; children?: string[] })[];
    defaultOption?: string;
    defaultNumber?: number;
  }[];
}

const GLOBAL = { projects: 'all', types: null } as const;

const SPECS: FieldSpec[] = [
  {
    name: 'Effort',
    description: 'Size of the work in points',
    kind: 'float',
    rate: 0.5,
    contexts: [{ name: 'Effort everywhere', ...GLOBAL, defaultNumber: 3 }],
  },
  {
    name: 'Customer',
    description: 'Who asked for it',
    kind: 'textfield',
    rate: 0.4,
    contexts: [
      {
        name: 'Customer in software',
        projects: 'software',
        types: ['Feature request', 'Defect'],
      },
    ],
  },
  {
    name: 'Steps to reproduce',
    description: 'How to see the problem',
    kind: 'textarea',
    rate: 0.6,
    contexts: [{ name: 'Steps for defects', projects: 'all', types: ['Defect'] }],
  },
  {
    name: 'Target date',
    description: 'When it should be ready',
    kind: 'datepicker',
    rate: 0.25,
    contexts: [{ name: 'Target date everywhere', ...GLOBAL }],
  },
  {
    name: 'Reviewed at',
    description: 'When the last review happened',
    kind: 'datetime',
    rate: 0.2,
    contexts: [{ name: 'Reviewed at everywhere', ...GLOBAL }],
  },
  {
    name: 'Severity',
    description: 'How bad it is',
    kind: 'select',
    rate: 0.45,
    contexts: [
      {
        name: 'Severity for the first project',
        projects: 'first',
        types: null,
        options: ['Urgent', 'Routine', { value: 'Someday', disabled: true }],
        defaultOption: 'Routine',
      },
      {
        name: 'Severity everywhere else',
        ...GLOBAL,
        options: ['Blocker', 'Major', 'Minor', { value: 'Cosmetic', disabled: true }],
        defaultOption: 'Minor',
      },
    ],
  },
  {
    name: 'Platforms',
    description: 'Where it shows up',
    kind: 'multiselect',
    rate: 0.3,
    contexts: [
      { name: 'Platforms everywhere', ...GLOBAL, options: ['Web', 'iOS', 'Android', 'Desktop'] },
    ],
  },
  {
    name: 'Channel',
    description: 'How it reached us',
    kind: 'radiobuttons',
    rate: 0.3,
    contexts: [
      { name: 'Channel everywhere', ...GLOBAL, options: ['Email', 'Phone', 'Chat', 'Portal'] },
    ],
  },
  {
    name: 'Checks',
    description: 'What was checked before closing',
    kind: 'multicheckboxes',
    rate: 0.25,
    contexts: [
      {
        name: 'Checks everywhere',
        ...GLOBAL,
        options: ['Tests', 'Docs', 'Changelog', 'Security review'],
      },
    ],
  },
  {
    name: 'Region',
    description: 'Where the customer is',
    kind: 'cascadingselect',
    rate: 0.3,
    contexts: [
      {
        name: 'Region everywhere',
        ...GLOBAL,
        options: [
          { value: 'Europe', children: ['North', 'South', 'Central'] },
          { value: 'Americas', children: ['North', 'South'] },
          { value: 'Asia', children: ['East', 'South-East'] },
        ],
      },
    ],
  },
  {
    name: 'Reviewer',
    description: 'Who reviews it',
    kind: 'userpicker',
    rate: 0.35,
    contexts: [{ name: 'Reviewer everywhere', ...GLOBAL }],
  },
  {
    name: 'Helpers',
    description: 'Who else works on it',
    kind: 'multiuserpicker',
    rate: 0.2,
    contexts: [{ name: 'Helpers everywhere', ...GLOBAL }],
  },
  {
    name: 'Owning group',
    description: 'The group that owns it',
    kind: 'grouppicker',
    rate: 0.25,
    contexts: [{ name: 'Owning group everywhere', ...GLOBAL }],
  },
  {
    name: 'Audience',
    description: 'Groups that should know',
    kind: 'multigrouppicker',
    rate: 0.15,
    contexts: [{ name: 'Audience everywhere', ...GLOBAL }],
  },
  {
    name: 'Topics',
    description: 'Topics it touches',
    kind: 'labels',
    rate: 0.3,
    contexts: [{ name: 'Topics everywhere', ...GLOBAL }],
  },
  {
    name: 'Design link',
    description: 'Where the design lives',
    kind: 'url',
    rate: 0.3,
    contexts: [{ name: 'Design link for features', projects: 'all', types: ['Feature request'] }],
  },
  {
    name: 'Legacy code',
    description: 'The code it had in the old tracker',
    kind: 'readonlyfield',
    rate: 0.2,
    contexts: [{ name: 'Legacy code everywhere', ...GLOBAL }],
  },
  {
    name: 'Rating',
    description: 'Stars from a plugin',
    kind: 'plugin',
    rate: 0.2,
    contexts: [{ name: 'Rating everywhere', ...GLOBAL }],
  },
];

/** The searcher each built-in type is written with (only for show; the importer ignores it). */
const SEARCHER: Partial<Record<FieldKind, string>> = {
  textfield: 'textsearcher',
  textarea: 'textsearcher',
  float: 'exactnumber',
  datepicker: 'daterange',
  datetime: 'datetimerange',
  select: 'multiselectsearcher',
  multiselect: 'multiselectsearcher',
  radiobuttons: 'radiosearcher',
  multicheckboxes: 'checkboxsearcher',
  cascadingselect: 'cascadingselectsearcher',
  userpicker: 'userpickergroupsearcher',
  multiuserpicker: 'userpickergroupsearcher',
  grouppicker: 'grouppickersearcher',
  multigrouppicker: 'grouppickersearcher',
  labels: 'labelsearcher',
  url: 'exacttextsearcher',
};

/** The type key of a plugin's field: one the importer cannot map. */
export const PLUGIN_FIELD_TYPE = 'com.example.ratings:stars';

const built = new WeakMap<World, FieldWorld>();

/** The world's fields and form configuration, built once per world. */
export function fieldWorldOf(world: World): FieldWorld {
  let out = built.get(world);
  if (!out) {
    out = buildFieldWorld(world);
    built.set(world, out);
  }
  return out;
}

function buildFieldWorld(world: Pick<World, 'projects' | 'issueTypes'>): FieldWorld {
  const typeId = (name: string) => (world.issueTypes.find((t) => t.name === name) as IssueType).id;
  const software = world.projects.filter((p) => p.type === 'software').map((p) => p.id);
  let contextId = FIRST_ID;
  let optionId = FIRST_ID;
  const fields: FieldDef[] = SPECS.map((spec, k) => {
    const contexts = spec.contexts.map((c): ContextDef => {
      const id = contextId++;
      const options: OptionDef[] = [];
      for (const [i, o] of (c.options ?? []).entries()) {
        const value = typeof o === 'string' ? o : o.value;
        const parent: OptionDef = {
          id: optionId++,
          value,
          sequence: i,
          disabled: typeof o !== 'string' && o.disabled === true,
          parent: null,
        };
        options.push(parent);
        if (typeof o !== 'string') {
          for (const [j, child] of (o.children ?? []).entries()) {
            options.push({
              id: optionId++,
              value: child,
              sequence: j,
              disabled: false,
              parent: parent.id,
            });
          }
        }
      }
      const first = world.projects[0] as Project;
      return {
        id,
        configId: id,
        name: c.name,
        description: `Where ${spec.name} applies`,
        projects: c.projects === 'all' ? null : c.projects === 'first' ? [first.id] : [...software],
        types: c.types === null ? null : c.types.map(typeId),
        options,
        defaultOption:
          c.defaultOption === undefined
            ? null
            : (options.find((o) => o.value === c.defaultOption && o.parent === null) as OptionDef)
                .id,
        defaultNumber: c.defaultNumber ?? null,
      };
    });
    const searcher = SEARCHER[spec.kind];
    return {
      id: FIRST_ID + k,
      name: spec.name,
      description: spec.description,
      kind: spec.kind,
      typeKey: spec.kind === 'plugin' ? PLUGIN_FIELD_TYPE : `${SYSTEM_FIELD_TYPES}${spec.kind}`,
      searcherKey: searcher ? `${SYSTEM_FIELD_TYPES}${searcher}` : null,
      rate: spec.rate,
      // A project's own context comes first: it wins over the one for every project.
      contexts,
    };
  });
  const cf = (name: string) => customFieldKey((fields.find((f) => f.name === name) as FieldDef).id);

  // Field configurations: every field listed, a few required, hidden or explained.
  const systemFields = [
    'summary',
    'issuetype',
    'description',
    'environment',
    'priority',
    'resolution',
    'assignee',
    'reporter',
    'duedate',
    'labels',
    'components',
    'fixVersions',
    'versions',
    'timetracking',
    'security',
    'attachment',
  ];
  const allFields = [...systemFields, ...fields.map((f) => customFieldKey(f.id))];
  const layout = (
    id: number,
    name: string,
    isDefault: boolean,
    overrides: Record<string, Partial<LayoutItemDef>>,
  ): FieldLayoutDef => ({
    id,
    name,
    description: `Field rules: ${name.toLowerCase()}`,
    isDefault,
    items: allFields.map((field) => ({
      field,
      required: field === 'summary' || field === 'issuetype',
      hidden: false,
      description: null,
      ...overrides[field],
    })),
  });
  const layouts = [
    layout(FIRST_ID, 'Standard field rules', true, {
      environment: { hidden: true },
      description: { description: 'What needs doing and why' },
    }),
    layout(FIRST_ID + 1, 'Defect field rules', false, {
      [cf('Steps to reproduce')]: { required: true, description: 'Numbered steps, please' },
      priority: { required: true },
      [cf('Rating')]: { hidden: true },
      security: { hidden: true },
      components: { hidden: true },
      duedate: { description: 'Fix by this day' },
    }),
    layout(FIRST_ID + 2, 'Business field rules', false, {
      [cf('Customer')]: { required: true },
      duedate: { required: true },
      timetracking: { hidden: true },
    }),
  ];
  const layoutSchemes: FieldLayoutSchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Software field rules',
      description: 'Rules for software projects',
      entities: [
        { type: null, layout: FIRST_ID },
        { type: typeId('Defect'), layout: FIRST_ID + 1 },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Business field rules',
      description: 'Rules for business projects',
      entities: [{ type: null, layout: FIRST_ID + 2 }],
    },
  ];
  // The second project keeps the default field configuration: it has no scheme.
  const layoutSchemeOf = new Map<number, number>();
  for (const p of world.projects) {
    if (p.index === 1) continue;
    layoutSchemeOf.set(p.id, p.type === 'software' ? FIRST_ID : FIRST_ID + 1);
  }

  const screens: ScreenDef[] = [
    {
      id: FIRST_ID,
      name: 'Standard screen',
      description: 'Every field of an issue',
      tabs: [
        {
          name: 'Fields',
          fields: [
            'summary',
            'issuetype',
            'priority',
            'assignee',
            'reporter',
            'description',
            'duedate',
            'labels',
            'components',
            'fixVersions',
            'timetracking',
            cf('Effort'),
            cf('Customer'),
            cf('Target date'),
            cf('Severity'),
            cf('Platforms'),
            cf('Channel'),
            cf('Region'),
          ],
        },
        {
          name: 'More',
          fields: [
            cf('Reviewer'),
            cf('Helpers'),
            cf('Owning group'),
            cf('Audience'),
            cf('Topics'),
            cf('Design link'),
            cf('Legacy code'),
            cf('Reviewed at'),
            cf('Checks'),
            cf('Rating'),
          ],
        },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Defect screen',
      description: 'Fields for reporting a defect',
      tabs: [
        {
          name: 'Fields',
          fields: [
            'summary',
            'issuetype',
            'priority',
            'assignee',
            'reporter',
            'description',
            'environment',
            'versions',
            cf('Steps to reproduce'),
            cf('Severity'),
            cf('Effort'),
          ],
        },
        { name: 'Triage', fields: [cf('Reviewer'), cf('Platforms'), 'security', cf('Rating')] },
      ],
    },
    {
      id: FIRST_ID + 2,
      name: 'Quick create screen',
      description: 'The few fields to start with',
      tabs: [{ name: 'Fields', fields: ['summary', 'issuetype', 'assignee', 'description'] }],
    },
  ];
  const screenSchemes: ScreenSchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Standard screens',
      description: 'Quick to create, everything after',
      items: [
        { operation: null, screen: FIRST_ID },
        { operation: 'create', screen: FIRST_ID + 2 },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Defect screens',
      description: 'One screen for defects',
      items: [{ operation: null, screen: FIRST_ID + 1 }],
    },
  ];
  const typeScreenSchemes: TypeScreenSchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Software screens',
      description: 'Screens of software projects',
      entities: [
        { type: null, screenScheme: FIRST_ID },
        { type: typeId('Defect'), screenScheme: FIRST_ID + 1 },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Business screens',
      description: 'Screens of business projects',
      entities: [{ type: null, screenScheme: FIRST_ID }],
    },
  ];
  const typeScreenSchemeOf = new Map<number, number>();
  for (const p of world.projects) {
    typeScreenSchemeOf.set(p.id, p.type === 'software' ? FIRST_ID : FIRST_ID + 1);
  }
  return {
    fields,
    layouts,
    layoutSchemes,
    screens,
    screenSchemes,
    typeScreenSchemes,
    layoutSchemeOf,
    typeScreenSchemeOf,
  };
}

/** The context of a field an issue falls in: a project's own first, then the general one. */
export function contextFor(field: FieldDef, issue: IssueFacts): ContextDef | null {
  const fits = (c: ContextDef) => c.types === null || c.types.includes(issue.type.id);
  return (
    field.contexts.find((c) => c.projects?.includes(issue.project.id) && fits(c)) ??
    field.contexts.find((c) => c.projects === null && fits(c)) ??
    null
  );
}

/** One custom value of an issue, as the backup holds it. */
export type CustomValue =
  | { kind: 'string'; field: FieldDef; values: string[] }
  | { kind: 'text'; field: FieldDef; text: string }
  | { kind: 'number'; field: FieldDef; number: number }
  | { kind: 'date'; field: FieldDef; at: number }
  | { kind: 'options'; field: FieldDef; options: number[] }
  | { kind: 'cascade'; field: FieldDef; parent: number; child: number | null }
  | { kind: 'people'; field: FieldDef; people: Person[] }
  | { kind: 'groups'; field: FieldDef; groups: string[] }
  | { kind: 'labels'; field: FieldDef; labels: string[] };

function distinct<T>(random: Random, from: readonly T[], max: number): T[] {
  const out = new Set<T>();
  for (let n = random.int(1, Math.min(max, from.length)); n > 0; n--) out.add(random.pick(from));
  return [...out];
}

/**
 * An issue's custom values, field by field, from its own seed stream. Only fields with a
 * context for the issue's project and type get one. People are present users (deleted people
 * stay in the person attributes of `format.ts`, so the counts of named deleted people do not
 * depend on these values).
 */
export function customValues(world: World, issue: IssueFacts): CustomValue[] {
  const r = Random.derive(world.options.seed, 'custom-values', issue.index);
  const out: CustomValue[] = [];
  for (const field of fieldWorldOf(world).fields) {
    const context = contextFor(field, issue);
    if (context === null || !r.chance(field.rate)) continue;
    // Mostly options people can still pick; now and then one disabled since.
    const parents = context.options.filter((o) => o.parent === null);
    const pickable = r.chance(0.05) ? parents : parents.filter((o) => !o.disabled);
    switch (field.kind) {
      case 'textfield':
        out.push({ kind: 'string', field, values: [`${words(r, 2)} ${r.int(1, 99)}`] });
        break;
      case 'textarea':
        out.push({ kind: 'text', field, text: paragraphs(r, 2) });
        break;
      case 'float':
        out.push({
          kind: 'number',
          field,
          number: r.chance(0.3) ? r.int(1, 400) / 8 : r.int(1, 21),
        });
        break;
      case 'datepicker': {
        const day = issue.created + r.int(0, 120) * DAY;
        out.push({ kind: 'date', field, at: day - (day % DAY) });
        break;
      }
      case 'datetime': {
        const at = between(r, issue.created, issue.updated);
        out.push({ kind: 'date', field, at: at - (at % 1000) });
        break;
      }
      case 'select':
      case 'radiobuttons':
        out.push({ kind: 'options', field, options: [r.pick(pickable).id] });
        break;
      case 'multiselect':
      case 'multicheckboxes':
        out.push({
          kind: 'options',
          field,
          options: distinct(r, pickable, 3)
            .map((o) => o.id)
            .sort((a, b) => a - b),
        });
        break;
      case 'cascadingselect': {
        const parent = r.pick(parents);
        const children = context.options.filter((o) => o.parent === parent.id);
        const child = children.length > 0 && r.chance(0.7) ? r.pick(children).id : null;
        out.push({ kind: 'cascade', field, parent: parent.id, child });
        break;
      }
      case 'userpicker':
      case 'multiuserpicker': {
        const people: Person[] = [];
        for (let n = field.kind === 'userpicker' ? 1 : r.int(1, 3); n > 0; n--) {
          const p = world.users[r.int(0, world.users.length - 1)] as Person;
          if (!people.includes(p)) people.push(p);
        }
        out.push({ kind: 'people', field, people });
        break;
      }
      case 'grouppicker':
        out.push({ kind: 'groups', field, groups: [r.pick(world.groups).name] });
        break;
      case 'multigrouppicker':
        out.push({
          kind: 'groups',
          field,
          groups: distinct(
            r,
            world.groups.map((g) => g.name),
            2,
          ),
        });
        break;
      case 'labels':
        out.push({ kind: 'labels', field, labels: distinct(r, TOPICS, 3) });
        break;
      case 'url':
        out.push({
          kind: 'string',
          field,
          values: [
            `https://designs.example.test/${issue.project.key.toLowerCase()}/${r.int(1, 9999)}`,
          ],
        });
        break;
      case 'readonlyfield':
        out.push({ kind: 'string', field, values: [`OLD-${r.int(100, 99_999)}`] });
        break;
      case 'plugin':
        out.push({ kind: 'string', field, values: [String(r.int(1, 5))] });
        break;
    }
  }
  return out;
}

/** The Effort value an issue has now, for its history (null when it has none). */
export function effortOf(world: World, issue: IssueFacts): number | null {
  const value = customValues(world, issue).find(
    (v) => v.kind === 'number' && v.field.name === 'Effort',
  );
  return value?.kind === 'number' ? value.number : null;
}

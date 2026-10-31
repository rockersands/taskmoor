import { CUSTOM_FIELD_KEY, SCREEN_OPERATIONS } from './format';

/**
 * The custom field and form configuration part of the stage (M1-089; IMP-004; ADR-089):
 * custom fields, their contexts (field configuration schemes with their projects and issue
 * types) and options, default values, field configurations in field configuration schemes,
 * and screens in screen schemes and issue type screen schemes, with the projects that use
 * each scheme. Rows come in any order, so everything is kept (it is small) and resolved after
 * the file. This is the format layer: records keep the backup's vocabulary; `../dc.ts` maps
 * them to fields, contexts, options, field rule sets and layout sets.
 */

export interface StagedField {
  id: string;
  name: string;
  description: string;
  typeKey: string;
}

export interface StagedContext {
  id: string;
  name: string;
  description: string;
  /** The field's id and type key; the type is null when the field has no row. */
  field: string;
  fieldType: string | null;
  /** Project ids, or null for every project. */
  projects: string[] | null;
  /** Issue type ids, or null for every type. */
  types: string[] | null;
  /** Scope rows the reader could not keep: project categories, unknown projects or types. */
  droppedScopes: string[];
  /** The default value as stored (an XML fragment), null without one. */
  defaultXml: string | null;
}

export interface StagedOption {
  id: string;
  /** The context (field configuration scheme) whose configuration holds the option. */
  context: string | null;
  field: string;
  fieldType: string | null;
  parent: string | null;
  sequence: number;
  value: string;
  disabled: boolean;
  /** Part of its context's default value. */
  isDefault: boolean;
}

export interface StagedRuleItem {
  field: string;
  required: boolean;
  hidden: boolean;
  description: string | null;
}

export interface StagedRuleSet {
  id: string;
  name: string;
  description: string;
  /** Issue type (null: every other type) to its field configuration's items. */
  entities: { type: string | null; layout: string; layoutName: string; items: StagedRuleItem[] }[];
  /** Entities whose field configuration has no row. */
  missingLayouts: string[];
  /** Project ids using it. */
  tracks: string[];
}

export interface StagedScreen {
  id: string;
  name: string;
  tabs: { name: string; fields: string[] }[];
}

export type StagedOperation = keyof typeof SCREEN_OPERATIONS;

export interface StagedLayoutSet {
  id: string;
  name: string;
  description: string;
  /** Issue type (null: every other type) to the screen each operation shows. */
  entities: {
    type: string | null;
    screenScheme: string;
    screens: { operation: StagedOperation; screen: StagedScreen | null }[];
  }[];
  tracks: string[];
}

const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
const byId = <T extends { id: string }>(rows: Iterable<T>) =>
  [...rows].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
const OPERATIONS = Object.entries(SCREEN_OPERATIONS) as [StagedOperation, number][];

/** The id of the default field configuration's rule set, which has no scheme row. */
export const DEFAULT_RULE_SET = 'default';

/** Elements this part reads. */
export const FIELD_ELEMENTS = [
  'CustomField',
  'CustomFieldOption',
  'FieldConfigScheme',
  'FieldConfiguration',
  'ConfigurationContext',
  'FieldConfigSchemeIssueType',
  'GenericConfiguration',
  'FieldLayout',
  'FieldLayoutItem',
  'FieldLayoutScheme',
  'FieldLayoutSchemeEntity',
  'FieldScreen',
  'FieldScreenTab',
  'FieldScreenLayoutItem',
  'FieldScreenScheme',
  'FieldScreenSchemeItem',
  'IssueTypeScreenScheme',
  'IssueTypeScreenSchemeEntity',
] as const;

interface Named {
  id: string;
  name: string;
  description: string;
}

export class FieldCollector {
  readonly fields = new Map<string, StagedField>();
  private readonly schemes = new Map<string, Named & { fieldKey: string }>();
  private readonly contexts: { scheme: string; project: string | null; category: string | null }[] =
    [];
  private readonly schemeTypes: { scheme: string; type: string | null; config: string }[] = [];
  private readonly options: (Omit<StagedOption, 'context' | 'fieldType' | 'isDefault'> & {
    config: string;
  })[] = [];
  private readonly defaults: { key: string; xml: string }[] = [];
  private readonly layouts = new Map<string, Named & { isDefault: boolean }>();
  private readonly layoutItems: (StagedRuleItem & { layout: string; position: number })[] = [];
  private readonly layoutSchemes = new Map<string, Named>();
  private readonly layoutEntities: { scheme: string; type: string | null; layout: string }[] = [];
  private readonly screens = new Map<string, Named>();
  private readonly tabs: { id: string; name: string; sequence: number; screen: string }[] = [];
  private readonly screenItems: { tab: string; field: string; sequence: number }[] = [];
  private readonly screenSchemes = new Map<string, Named>();
  private readonly screenSchemeItems: {
    scheme: string;
    operation: number | null;
    screen: string;
  }[] = [];
  private readonly typeScreenSchemes = new Map<string, Named>();
  private readonly typeScreenEntities: {
    scheme: string;
    type: string | null;
    screenScheme: string;
  }[] = [];

  /** Reads one row of an element in `FIELD_ELEMENTS`. */
  row(name: string, v: Record<string, string>): void {
    const id = v.id ?? '';
    const named = (): Named => ({ id, name: v.name ?? '', description: v.description ?? '' });
    switch (name) {
      case 'CustomField':
        this.fields.set(id, {
          id,
          name: v.cfname ?? '',
          description: v.description ?? '',
          typeKey: v.customfieldtypekey ?? '',
        });
        return;
      case 'FieldConfigScheme':
        this.schemes.set(id, { ...named(), fieldKey: v.fieldid ?? '' });
        return;
      case 'ConfigurationContext':
        this.contexts.push({
          scheme: v.fieldconfigscheme ?? '',
          project: v.project ?? null,
          category: v.projectcategory ?? null,
        });
        return;
      case 'FieldConfigSchemeIssueType':
        this.schemeTypes.push({
          scheme: v.fieldconfigscheme ?? '',
          type: v.issuetype ?? null,
          config: v.fieldconfiguration ?? '',
        });
        return;
      case 'CustomFieldOption':
        this.options.push({
          id,
          field: v.customfield ?? '',
          config: v.customfieldconfig ?? '',
          parent: v.parentoptionid ?? null,
          sequence: int(v.sequence) ?? 0,
          value: v.customvalue ?? '',
          disabled: v.disabled === 'Y' || v.disabled === 'true',
        });
        return;
      case 'GenericConfiguration':
        if (v.datatype === 'DefaultValue' && v.datakey && v.xmlvalue) {
          this.defaults.push({ key: v.datakey, xml: v.xmlvalue });
        }
        return;
      case 'FieldLayout':
        this.layouts.set(id, { ...named(), isDefault: v.type === 'default' });
        return;
      case 'FieldLayoutItem':
        this.layoutItems.push({
          layout: v.fieldlayout ?? '',
          field: v.fieldidentifier ?? '',
          required: v.isrequired === 'true',
          hidden: v.ishidden === 'true',
          description: v.description ? v.description : null,
          position: int(v.verticalposition) ?? 0,
        });
        return;
      case 'FieldLayoutScheme':
        this.layoutSchemes.set(id, named());
        return;
      case 'FieldLayoutSchemeEntity':
        this.layoutEntities.push({
          scheme: v.scheme ?? '',
          type: v.issuetype ?? null,
          layout: v.fieldlayout ?? '',
        });
        return;
      case 'FieldScreen':
        this.screens.set(id, named());
        return;
      case 'FieldScreenTab':
        this.tabs.push({
          id,
          name: v.name ?? '',
          sequence: int(v.sequence) ?? 0,
          screen: v.fieldscreen ?? '',
        });
        return;
      case 'FieldScreenLayoutItem':
        this.screenItems.push({
          tab: v.fieldscreentab ?? '',
          field: v.fieldidentifier ?? '',
          sequence: int(v.sequence) ?? 0,
        });
        return;
      case 'FieldScreenScheme':
        this.screenSchemes.set(id, named());
        return;
      case 'FieldScreenSchemeItem':
        this.screenSchemeItems.push({
          scheme: v.fieldscreenscheme ?? '',
          operation: int(v.operation),
          screen: v.fieldscreen ?? '',
        });
        return;
      case 'IssueTypeScreenScheme':
        this.typeScreenSchemes.set(id, named());
        return;
      case 'IssueTypeScreenSchemeEntity':
        this.typeScreenEntities.push({
          scheme: v.scheme ?? '',
          type: v.issuetype ?? null,
          screenScheme: v.fieldscreenscheme ?? '',
        });
        return;
    }
  }

  /** The custom field a configuration key names (`customfield_<id>`), or null. */
  fieldOfKey(key: string): StagedField | null {
    const m = CUSTOM_FIELD_KEY.exec(key);
    return m ? (this.fields.get(m[1] as string) ?? null) : null;
  }

  /**
   * The staged records, with references resolved. `associations` maps each scheme element to
   * the projects naming it; `projects` and `types` are the ids that exist.
   */
  /** A screen with its tabs and their fields, in order; null when it has no row. */
  screen(id: string): StagedScreen | null {
    const screen = this.screens.get(id);
    if (!screen) return null;
    const tabs = this.tabs
      .filter((t) => t.screen === id)
      .sort((a, b) => a.sequence - b.sequence || Number(a.id) - Number(b.id))
      .map((t) => ({
        name: t.name,
        fields: this.screenItems
          .filter((i) => i.tab === t.id)
          .sort((a, b) => a.sequence - b.sequence)
          .map((i) => i.field),
      }));
    return { id, name: screen.name, tabs };
  }

  resolve(
    projects: ReadonlySet<string>,
    types: ReadonlySet<string>,
    associations: ReadonlyMap<string, Map<string, string[]>>,
  ) {
    const typeOf = (t: string | null) => (t === null || types.has(t) ? t : undefined);

    // Contexts, and which context each field configuration belongs to.
    const contextOfConfig = new Map<string, string>();
    for (const st of this.schemeTypes) contextOfConfig.set(st.config, st.scheme);
    const defaults = new Map<string, string>();
    for (const d of this.defaults) defaults.set(d.key, d.xml);
    const contextRecords = byId(this.schemes.values()).map((s) => {
      const field = this.fieldOfKey(s.fieldKey);
      const dropped: string[] = [];
      let projectIds: string[] | null = [];
      for (const c of this.contexts.filter((x) => x.scheme === s.id)) {
        if (c.project === null && c.category === null) projectIds = null;
        else if (c.project !== null && projects.has(c.project)) {
          if (projectIds !== null && !projectIds.includes(c.project)) projectIds.push(c.project);
        } else dropped.push(c.project === null ? `category:${c.category}` : `project:${c.project}`);
      }
      let typeIds: string[] | null = [];
      const configs = new Set<string>();
      for (const st of this.schemeTypes.filter((x) => x.scheme === s.id)) {
        configs.add(st.config);
        const t = typeOf(st.type);
        if (t === undefined) dropped.push(`type:${st.type}`);
        else if (t === null) typeIds = null;
        else if (typeIds !== null && !typeIds.includes(t)) typeIds.push(t);
      }
      let defaultXml: string | null = null;
      for (const config of [...configs].sort()) defaultXml ??= defaults.get(config) ?? null;
      const data: StagedContext = {
        id: s.id,
        name: s.name,
        description: s.description,
        field: field?.id ?? s.fieldKey,
        fieldType: field?.typeKey ?? null,
        projects: projectIds?.sort((a, b) => Number(a) - Number(b)) ?? null,
        types: typeIds?.sort((a, b) => Number(a) - Number(b)) ?? null,
        droppedScopes: dropped,
        defaultXml,
      };
      return { id: s.id, label: `${field?.name ?? s.fieldKey}: ${s.name}`, data };
    });

    // Options: parents first, each with its context and whether it is a default.
    const defaultIds = new Set<string>();
    for (const d of this.defaults) {
      for (const m of d.xml.matchAll(/<(?:string|long)>\s*(\d+)\s*<\/(?:string|long)>/g)) {
        defaultIds.add(`${d.key}:${m[1]}`);
      }
    }
    const optionRecords = [...this.options]
      .sort(
        (a, b) =>
          Number(a.parent !== null) - Number(b.parent !== null) || Number(a.id) - Number(b.id),
      )
      .map((o) => {
        const field = this.fields.get(o.field);
        const data: StagedOption = {
          id: o.id,
          context: contextOfConfig.get(o.config) ?? null,
          field: o.field,
          fieldType: field?.typeKey ?? null,
          parent: o.parent,
          sequence: o.sequence,
          value: o.value,
          disabled: o.disabled,
          isDefault: defaultIds.has(`${o.config}:${o.id}`),
        };
        return { id: o.id, label: `${field?.name ?? o.field}: ${o.value}`, data };
      });

    // Field rule sets: a scheme's entities with their configuration's items.
    const itemsOf = (layout: string): StagedRuleItem[] =>
      this.layoutItems
        .filter((i) => i.layout === layout)
        .sort((a, b) => a.position - b.position)
        .map(({ field, required, hidden, description }) => ({
          field,
          required,
          hidden,
          description,
        }));
    const tracksOf = (element: string, id: string) =>
      (associations.get(element)?.get(id) ?? [])
        .filter((p) => projects.has(p))
        .sort((a, b) => Number(a) - Number(b));
    const ruleSet = (
      s: Named,
      entities: { type: string | null; layout: string }[],
      tracks: string[],
    ) => {
      const missing: string[] = [];
      const out: StagedRuleSet['entities'] = [];
      for (const e of entities) {
        const layout = this.layouts.get(e.layout);
        const type = typeOf(e.type);
        if (!layout || type === undefined) {
          missing.push(!layout ? `layout:${e.layout}` : `type:${e.type}`);
          continue;
        }
        out.push({ type, layout: layout.id, layoutName: layout.name, items: itemsOf(layout.id) });
      }
      const data: StagedRuleSet = {
        id: s.id,
        name: s.name,
        description: s.description,
        entities: out,
        missingLayouts: missing,
        tracks,
      };
      return { id: s.id, label: s.name, data };
    };
    const ruleSets = byId(this.layoutSchemes.values()).map((s) =>
      ruleSet(
        s,
        this.layoutEntities.filter((e) => e.scheme === s.id),
        tracksOf('FieldLayoutScheme', s.id),
      ),
    );
    // Projects with no scheme use the default field configuration: a set of its own.
    const withScheme = new Set([...(associations.get('FieldLayoutScheme')?.values() ?? [])].flat());
    const defaultLayout = byId(this.layouts.values()).find((l) => l.isDefault);
    const without = [...projects].filter((p) => !withScheme.has(p));
    if (defaultLayout && without.length > 0) {
      ruleSets.push(
        ruleSet(
          {
            id: DEFAULT_RULE_SET,
            name: defaultLayout.name,
            description: defaultLayout.description,
          },
          [{ type: null, layout: defaultLayout.id }],
          without.sort((a, b) => Number(a) - Number(b)),
        ),
      );
    }

    // Layout sets: an issue type screen scheme, each type's screen scheme, each operation's screen.
    const screenOf = (id: string) => this.screen(id);
    const layoutSets = byId(this.typeScreenSchemes.values()).map((s) => {
      const entities: StagedLayoutSet['entities'] = [];
      for (const e of this.typeScreenEntities.filter((x) => x.scheme === s.id)) {
        const type = typeOf(e.type);
        if (type === undefined) continue;
        const items = this.screenSchemeItems.filter((i) => i.scheme === e.screenScheme);
        const fallback = items.find((i) => i.operation === null);
        entities.push({
          type,
          screenScheme: e.screenScheme,
          screens: OPERATIONS.map(([operation, number]) => {
            const item = items.find((i) => i.operation === number) ?? fallback;
            return { operation, screen: item ? screenOf(item.screen) : null };
          }),
        });
      }
      entities.sort((a, b) =>
        a.type === null ? -1 : b.type === null ? 1 : Number(a.type) - Number(b.type),
      );
      const data: StagedLayoutSet = {
        id: s.id,
        name: s.name,
        description: s.description,
        entities,
        tracks: tracksOf('IssueTypeScreenScheme', s.id),
      };
      return { id: s.id, label: s.name, data };
    });

    return {
      field: byId(this.fields.values()).map((f) => ({ id: f.id, label: f.name, data: f })),
      field_context: contextRecords,
      field_option: optionRecords,
      field_rule_set: ruleSets,
      layout_set: layoutSets,
    };
  }
}

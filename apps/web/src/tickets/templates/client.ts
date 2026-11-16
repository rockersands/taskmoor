import type { PmJson } from '@taskmoor/richtext';
import { api } from '../../api/client';
import {
  findFieldPeople,
  findGroups,
  findPeople,
  findSitePeople,
  findTeams,
} from '../pickerSources';

/**
 * Ticket templates (CORE-029, CORE-030; ADR-113) as the API gives them. Default values are named
 * as the ticket create route names its body, so `start` is a create body.
 */
export interface TemplateDefaults {
  priorityId?: number;
  labels?: string[];
  assigneeId?: number;
  areaIds?: number[];
  targetReleaseIds?: number[];
  foundInReleaseIds?: number[];
  dueInDays?: number;
  startInDays?: number;
  fields?: Record<string, unknown>;
}

export interface TemplateSubticket {
  summary: string;
  ticketTypeId?: number | null;
}

export interface SavedTemplate {
  id: number;
  name: string;
  purpose: string;
  track: { id: number; key: string; name: string } | null;
  ticketTypeIds: number[];
  summary: string;
  description: PmJson | null;
  defaults: TemplateDefaults;
  /**
   * Who `defaults.assigneeId` assigns, when the reader may see them named: an active person, to
   * holders of "See people and groups" (T-283); null otherwise, the id staying in the defaults.
   */
  assignee: { id: number; name: string } | null;
  subtickets: TemplateSubticket[];
  version: number;
  mayEdit: boolean;
}

export interface TemplateList {
  templates: SavedTemplate[];
  /** Whether this person may add templates here. */
  mayCreate: boolean;
}

/** What a template is saved with; a change leaves out the track. */
export interface TemplateBody {
  track?: string | null;
  name: string;
  purpose: string;
  ticketTypeIds: number[];
  summary: string;
  description: PmJson | null;
  defaults: TemplateDefaults;
  subtickets: TemplateSubticket[];
  version?: number;
}

/** What a ticket made from a template came to. */
export interface AppliedTemplate {
  key: string;
  /** The template's values the create route refused for this person, as body keys. */
  left: string[];
  subtickets: { summary: string; key: string | null; error: string | null }[];
}

export interface Named {
  id: number;
  name: string;
}
export interface TypeOption extends Named {
  level?: { rank: number };
}
/** A custom field a template can hold a value for, with its options once loaded. */
export interface FieldChoice extends Named {
  type: string;
  multiple: boolean;
}
export interface FieldValueOption {
  id: number;
  value: string;
}

/** A track's release or area; an archived one is named but not offered anew. */
export interface TrackChoice extends Named {
  archived?: boolean;
}

/**
 * One of a custom field's contexts as the template form reads it (T-350): the tracks and ticket
 * types it covers (null: all of them), and whether it allows only some people (a person field
 * limited to a group or a role, CORE-009 (2)).
 */
export interface FieldRule {
  id: number;
  trackIds: number[] | null;
  ticketTypeIds: number[] | null;
  restricted: boolean;
}

/** What the template form offers. */
export interface TemplateOptions {
  track: { id: number; key: string; name: string } | null;
  types: TypeOption[];
  priorities: Named[];
  /** The track's areas and releases, archived ones included to name what a template holds. */
  areas: TrackChoice[];
  releases: TrackChoice[];
  fields: FieldChoice[];
}

/**
 * What a template starts a ticket with in a track: a create body (`start`), and the names of
 * the people, groups and teams its custom values name, by body key (`fields.12`), as far as the
 * reader may see them (T-276). A value with no name here stays out of the form's pickers.
 */
export interface TemplateStart {
  start: Record<string, unknown>;
  names: Record<string, Named[]>;
}

/** The endpoints the create form's picker uses. Stories and tests pass their own. */
export interface PickerClient {
  list: (track: string, ticketTypeId: number) => Promise<SavedTemplate[]>;
  /**
   * What a template starts a ticket of a type in a track with: a person field limited to some
   * people names those its own list offers for that type (T-284).
   */
  start: (id: number, track: string, ticketTypeId: number) => Promise<TemplateStart>;
  apply: (id: number, body: Record<string, unknown>) => Promise<AppliedTemplate>;
}

/** The endpoints the templates page uses. Stories and tests pass their own. */
export interface TemplateClient {
  /** The templates of a track and those for every track; those for every track without one. */
  list: (track: string | null) => Promise<TemplateList>;
  options: (track: string | null) => Promise<TemplateOptions>;
  fieldOptions: (fieldId: number, trackId: number | null) => Promise<FieldValueOption[]>;
  /**
   * People who can be found in a track, for its templates' person fields: the create form's
   * search (T-350).
   */
  people: (track: string, query: string) => Promise<Named[]>;
  /**
   * People who may be given tickets in a track, for its templates' assignee: the create form's
   * assignee search (T-269), so a template offers only those a ticket can be given to.
   */
  assignable: (track: string, query: string) => Promise<Named[]>;
  /**
   * Anyone active in the site, for a person field of a template for every track (T-350), which
   * has no track to search in; those who change such templates may use it (ADR-114).
   */
  sitePeople: (query: string) => Promise<Named[]>;
  /** The people a person field allows for a ticket of a type in a track (CORE-009 (2), T-350). */
  fieldPeople: (
    fieldId: number,
    track: string,
    ticketTypeId: number,
    query: string,
  ) => Promise<Named[]>;
  /** The site's groups a group field offers, as on the create form (T-350). */
  groups: (fieldId: number, query: string) => Promise<Named[]>;
  /** The site's teams, as on the create form (T-350). */
  teams: (query: string) => Promise<Named[]>;
  /** A custom field's contexts, to know whom a person field allows (T-350). */
  fieldRules: (fieldId: number) => Promise<FieldRule[]>;
  /**
   * The names of the people, groups and teams a template's custom values name, by body key
   * (`fields.12`), as far as the reader may see them (T-299); a value with no name here is one
   * they may not see, or one that is gone.
   */
  names: (id: number) => Promise<Record<string, Named[]>>;
  create: (body: TemplateBody) => Promise<SavedTemplate>;
  update: (id: number, body: TemplateBody) => Promise<SavedTemplate>;
  remove: (id: number) => Promise<void>;
}

const templatesPath = '/ticket-templates';

export const pickerClient: PickerClient = {
  list: async (track, ticketTypeId) =>
    (
      await api<TemplateList>(
        `${templatesPath}?track=${encodeURIComponent(track)}&ticketTypeId=${ticketTypeId}`,
      )
    ).templates,
  start: async (id, track, ticketTypeId) => {
    const res = await api<{ start: Record<string, unknown>; names?: Record<string, Named[]> }>(
      `${templatesPath}/${id}?track=${encodeURIComponent(track)}&ticketTypeId=${ticketTypeId}`,
    );
    return { start: res.start, names: res.names ?? {} };
  },
  apply: async (id, body) => {
    const res = await api<Omit<AppliedTemplate, 'key'> & { ticket: { key: string } }>(
      `${templatesPath}/${id}/tickets`,
      { method: 'POST', body },
    );
    return { key: res.ticket.key, left: res.left, subtickets: res.subtickets };
  },
};

export const templateClient: TemplateClient = {
  list: (track) =>
    api<TemplateList>(
      track === null ? templatesPath : `${templatesPath}?track=${encodeURIComponent(track)}`,
    ),
  options: async (key) => {
    const priorities = (await api<{ priorities: Named[] }>('/priorities')).priorities;
    if (key === null) {
      const [types, fields] = await Promise.all([
        api<{ ticketTypes: TypeOption[] }>('/ticket-types'),
        api<{ fields: (FieldChoice & { trackId: number | null })[] }>('/fields'),
      ]);
      return {
        track: null,
        types: types.ticketTypes,
        priorities,
        areas: [],
        releases: [],
        fields: fields.fields.filter((f) => f.trackId === null),
      };
    }
    const path = encodeURIComponent(key);
    const { track } = await api<{ track: { id: number; key: string; name: string } }>(
      `/tracks/${path}`,
    );
    const [types, areas, releases, fields] = await Promise.all([
      api<{ ticketTypes: TypeOption[] }>(`/tracks/${path}/ticket-types`),
      // Each list comes whole, in one answer; archived ones name what a template already holds.
      api<{ areas: (Named & { archived: boolean })[] }>(
        `/tracks/${track.id}/areas?archived=include`,
      ),
      api<{ releases: (Named & { archived: boolean })[] }>(
        `/tracks/${track.id}/releases?archived=include`,
      ),
      api<{ fields: FieldChoice[] }>(`/fields?trackId=${track.id}`),
    ]);
    return {
      track,
      types: types.ticketTypes,
      priorities,
      areas: areas.areas.map(({ id, name, archived }) => ({ id, name, archived })),
      releases: releases.releases.map(({ id, name, archived }) => ({ id, name, archived })),
      fields: fields.fields,
    };
  },
  fieldOptions: async (fieldId, trackId) => {
    const { field } = await api<{
      field: {
        contexts: {
          trackIds: number[] | null;
          options?: (FieldValueOption & { disabled: boolean })[];
        }[];
      };
    }>(`/fields/${fieldId}`);
    const seen = new Map<number, FieldValueOption>();
    for (const context of field.contexts) {
      const covers =
        context.trackIds === null || trackId === null || context.trackIds.includes(trackId);
      if (!covers) continue;
      for (const option of context.options ?? []) {
        if (!option.disabled) seen.set(option.id, { id: option.id, value: option.value });
      }
    }
    return [...seen.values()];
  },
  people: (track, query) => findPeople(track, query),
  assignable: (track, query) => findPeople(track, query, true),
  sitePeople: findSitePeople,
  fieldPeople: findFieldPeople,
  groups: findGroups,
  teams: findTeams,
  fieldRules: async (fieldId) => {
    const { field } = await api<{
      field: {
        contexts: {
          id: number;
          trackIds: number[] | null;
          ticketTypeIds: number[] | null;
          config: { userGroupId?: number | null; userRoleId?: number | null } | null;
        }[];
      };
    }>(`/fields/${fieldId}`);
    return field.contexts.map((c) => ({
      id: c.id,
      trackIds: c.trackIds,
      ticketTypeIds: c.ticketTypeIds,
      restricted: c.config?.userGroupId != null || c.config?.userRoleId != null,
    }));
  },
  names: async (id) =>
    (await api<{ names?: Record<string, Named[]> }>(`${templatesPath}/${id}`)).names ?? {},
  create: async (body) =>
    (await api<{ template: SavedTemplate }>(templatesPath, { method: 'POST', body })).template,
  update: async (id, body) =>
    (await api<{ template: SavedTemplate }>(`${templatesPath}/${id}`, { method: 'PATCH', body }))
      .template,
  remove: async (id) => {
    await api<unknown>(`${templatesPath}/${id}`, { method: 'DELETE' });
  },
};

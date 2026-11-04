import { api } from '../api/client';
import { type TrackScopeClient, trackScopeClient } from '../sets/trackScope';
import type { LayoutEntry, Operation, SectionKind } from './model';

export interface Named {
  id: number;
  name: string;
}

/** A ticket type or custom field; `trackId` names a local-mode track's own. */
export interface Owned extends Named {
  trackId: number | null;
}

export interface LayoutSetSummary {
  id: number;
  name: string;
  description: string;
  /** A local-mode track's own set; null when shared. */
  trackId: number | null;
  isDefault: boolean;
}

export interface LayoutSet extends LayoutSetSummary {
  /** The tracks that use the set (CORE-003 (2)). */
  usedBy: { id: number; key: string; name: string }[];
  layouts: LayoutEntry[];
}

export interface PreviewField {
  key: string;
  required: boolean;
  description: string | null;
}

/** What `POST /api/v1/layout-sets/:id/preview` answers: the form, as the server resolves it. */
export interface Preview {
  /** Which layout the form uses: the type's own, the one for every type, or none. */
  source: 'type' | 'every_type' | 'none';
  layout: {
    operation: Operation;
    /** A null name is the one tab of a form without a layout, or the tab of the rest. */
    tabs: {
      name: string | null;
      sections: { kind: SectionKind; hideWhenEmpty: boolean; fields: PreviewField[] }[];
    }[];
  };
  /** Fields the layout places that the form leaves out, and why. */
  leftOut: { field: string; reason: 'hidden' | 'not_applicable' | 'computed' }[];
  customFields: Named[];
}

export interface PreviewRequest {
  ticketTypeId: number;
  operation: Operation;
  /** Null: no track, so the fields every track has and the default rules. */
  trackId: number | null;
  layouts: LayoutEntry[];
}

/** The endpoints the layout editor uses. Stories and tests pass their own. */
export interface LayoutsClient extends TrackScopeClient {
  /** The shared ticket types, and a local-mode track's own with its id. */
  ticketTypes: (trackId: number | null) => Promise<Owned[]>;
  /** The ticket types a type set offers: what a local-mode track's own page previews. */
  typeSetTypes: (typeSetId: number) => Promise<Owned[]>;
  /**
   * Null: every custom field the person sees, shared and local-mode tracks' own. A track: the
   * fields that reach it, its own and the shared ones whose context covers it.
   */
  customFields: (trackId: number | null) => Promise<Owned[]>;
  /** Null: every set the person sees. A track: the shared sets and that track's own. */
  layoutSets: (trackId: number | null) => Promise<LayoutSetSummary[]>;
  layoutSet: (id: number) => Promise<LayoutSet>;
  /** With a track: a set that local-mode track owns. */
  createLayoutSet: (body: { name: string; trackId?: number }) => Promise<LayoutSet>;
  updateLayoutSet: (
    id: number,
    change: { name?: string; layouts?: LayoutEntry[] },
  ) => Promise<LayoutSet>;
  deleteLayoutSet: (id: number) => Promise<void>;
  preview: (id: number, body: PreviewRequest) => Promise<Preview>;
  /** Makes a track use one of its own sets (`PATCH /api/v1/tracks/:id`). */
  assignLayoutSet: (trackId: number, setId: number) => Promise<void>;
}

export const layoutsClient: LayoutsClient = {
  ...trackScopeClient,
  ticketTypes: async (trackId) =>
    (
      await api<{ ticketTypes: (Named & { trackId?: number | null })[] }>(
        trackId === null ? '/ticket-types' : `/ticket-types?trackId=${trackId}`,
      )
    ).ticketTypes.map((t) => ({ id: t.id, name: t.name, trackId: t.trackId ?? null })),
  typeSetTypes: async (typeSetId) =>
    (
      await api<{ typeSet: { ticketTypes: (Named & { trackId?: number | null })[] } }>(
        `/type-sets/${typeSetId}`,
      )
    ).typeSet.ticketTypes.map((t) => ({ id: t.id, name: t.name, trackId: t.trackId ?? null })),
  customFields: async (trackId) =>
    (
      await api<{ fields: Owned[] }>(trackId === null ? '/fields' : `/fields?trackId=${trackId}`)
    ).fields.map((f) => ({
      id: f.id,
      name: f.name,
      trackId: f.trackId ?? null,
    })),
  layoutSets: async (trackId) =>
    (
      await api<{ layoutSets: LayoutSetSummary[] }>(
        trackId === null ? '/layout-sets' : `/layout-sets?trackId=${trackId}`,
      )
    ).layoutSets,
  layoutSet: async (id) => (await api<{ layoutSet: LayoutSet }>(`/layout-sets/${id}`)).layoutSet,
  createLayoutSet: async (body) =>
    (await api<{ layoutSet: LayoutSet }>('/layout-sets', { method: 'POST', body })).layoutSet,
  updateLayoutSet: async (id, change) =>
    (await api<{ layoutSet: LayoutSet }>(`/layout-sets/${id}`, { method: 'PATCH', body: change }))
      .layoutSet,
  deleteLayoutSet: async (id) => {
    await api<unknown>(`/layout-sets/${id}`, { method: 'DELETE' });
  },
  preview: async (id, body) =>
    (await api<{ preview: Preview }>(`/layout-sets/${id}/preview`, { method: 'POST', body }))
      .preview,
  assignLayoutSet: async (trackId, setId) => {
    await api<unknown>(`/tracks/${trackId}`, { method: 'PATCH', body: { layoutSetId: setId } });
  },
};

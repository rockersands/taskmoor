import { api } from '../api/client';
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
export interface LayoutsClient {
  /** The shared ticket types, and a local-mode track's own with its id. */
  ticketTypes: (trackId: number | null) => Promise<Owned[]>;
  /** Every custom field the person sees: shared, and local-mode tracks' own. */
  customFields: () => Promise<Owned[]>;
  layoutSets: () => Promise<LayoutSetSummary[]>;
  layoutSet: (id: number) => Promise<LayoutSet>;
  createLayoutSet: (body: { name: string }) => Promise<LayoutSet>;
  updateLayoutSet: (
    id: number,
    change: { name?: string; layouts?: LayoutEntry[] },
  ) => Promise<LayoutSet>;
  deleteLayoutSet: (id: number) => Promise<void>;
  preview: (id: number, body: PreviewRequest) => Promise<Preview>;
}

export const layoutsClient: LayoutsClient = {
  ticketTypes: async (trackId) =>
    (
      await api<{ ticketTypes: (Named & { trackId?: number | null })[] }>(
        trackId === null ? '/ticket-types' : `/ticket-types?trackId=${trackId}`,
      )
    ).ticketTypes.map((t) => ({ id: t.id, name: t.name, trackId: t.trackId ?? null })),
  customFields: async () =>
    (await api<{ fields: Owned[] }>('/fields')).fields.map((f) => ({
      id: f.id,
      name: f.name,
      trackId: f.trackId ?? null,
    })),
  layoutSets: async () =>
    (await api<{ layoutSets: LayoutSetSummary[] }>('/layout-sets')).layoutSets,
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
};

import { api } from '../api/client';

/** A label with how many tickets have it, those in the trash included (CORE-017). */
export interface LabelUsage {
  name: string;
  ticketCount: number;
}

/** A page of labels in the suggestions' order, and whether more follow it. */
export interface LabelPage {
  labels: LabelUsage[];
  more: boolean;
}

/** What `POST /api/v1/labels/merge` answers: the labels merged, without the one they became. */
export interface MergedLabels {
  into: string;
  labels: string[];
  ticketCount: number;
}

/** How a page of labels is asked for: those that start with `q`, after the label `after`. */
export interface LabelPageQuery {
  q?: string;
  after?: string;
  limit?: number;
}

/** The labels a merge takes at most, as the server takes them. */
export const MERGE_MAX = 100;

/** The longest label, as the server takes it (`tickets/fields.ts`). */
export const LABEL_MAX = 255;

/**
 * The endpoints the Labels page uses (`routes/priorities.ts`, T-322). Stories and tests pass
 * their own. Both are for site and configuration administrators.
 */
export interface LabelsClient {
  usage: (query: LabelPageQuery) => Promise<LabelPage>;
  merge: (labels: string[], into: string) => Promise<MergedLabels>;
}

export const labelsClient: LabelsClient = {
  usage: async ({ q, after, limit }) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (after !== undefined) params.set('after', after);
    if (limit !== undefined) params.set('limit', String(limit));
    const query = params.toString();
    return api<LabelPage>(`/labels/usage${query ? `?${query}` : ''}`);
  },
  merge: (labels, into) =>
    api<MergedLabels>('/labels/merge', { method: 'POST', body: { labels, into } }),
};

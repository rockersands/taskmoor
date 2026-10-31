import { AI_FEATURES, type AiSettings, type FeatureId, resolveFeature } from '@taskmoor/ai';
import type { AiPolicy } from './usage';

/**
 * The data-egress statement (M1-077; IAM-022 (2); ADR-100): what leaves the instance for each
 * AI feature, to which provider, model and region, and what never does. Generated from the
 * feature registry and the current settings, so it changes when they do. The web app words it.
 */
export type DataKind =
  | 'question'
  | 'ticket-fields'
  | 'comments'
  | 'field-names'
  | 'track-settings'
  | 'pasted-text'
  | 'candidate-tickets'
  | 'tool-results';

/** What each feature sends. Typed by the registry: a new feature needs its entry here. */
export const FEATURE_DATA: Record<FeatureId, readonly DataKind[]> = {
  summarize: ['ticket-fields', 'comments'],
  'query-from-text': ['question', 'field-names'],
  'assisted-creation': ['pasted-text', 'track-settings', 'field-names'],
  duplicates: ['ticket-fields', 'candidate-tickets'],
};

/** Never sent by any feature, whatever the settings. */
export const NEVER_SENT = [
  'hidden-tickets',
  'hidden-fields',
  'redacted-fields',
  'attachments',
  'credentials',
] as const;

export interface DataStatement {
  configured: boolean;
  provider: string | null;
  region: string | null;
  features: {
    id: FeatureId;
    enabled: boolean;
    model: string;
    effort: string;
    sends: readonly DataKind[];
  }[];
  redaction: { patterns: string[]; terms: number; fields: string[] };
  contentDays: number;
  neverSent: readonly string[];
}

export function dataStatement(
  provider: { id: string; region: string | null; features?: AiSettings['features'] } | null,
  policy: AiPolicy,
): DataStatement {
  return {
    configured: provider !== null,
    provider: provider?.id ?? null,
    region: provider?.region ?? null,
    features: (Object.keys(AI_FEATURES) as FeatureId[]).map((id) => {
      const resolved = resolveFeature(id, provider?.features?.[id]);
      return {
        id,
        enabled: resolved.enabled,
        model: resolved.model,
        effort: resolved.effort,
        sends: FEATURE_DATA[id],
      };
    }),
    redaction: {
      patterns: policy.patterns,
      terms: policy.terms.length,
      fields: policy.redactedFields,
    },
    contentDays: policy.contentDays,
    neverSent: NEVER_SENT,
  };
}

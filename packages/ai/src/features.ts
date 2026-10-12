import { type ClaudeModelId, DEFAULT_MODEL, type Effort, type FeatureSettings } from './config';

export interface FeatureSpec {
  title: string;
  /** Reasoning depth for the default model; administrators can raise or lower it. */
  effort: Effort;
  maxOutputTokens: number;
}

/** Every AI feature the product offers, with its defaults. New features are added here first. */
export const AI_FEATURES = {
  summarize: { title: 'Summaries of tickets and threads', effort: 'medium', maxOutputTokens: 1024 },
  'query-from-text': {
    title: 'Plain-language search turned into a query',
    effort: 'high',
    maxOutputTokens: 1024,
  },
  'assisted-creation': {
    title: 'Draft tickets from a description',
    effort: 'medium',
    maxOutputTokens: 4096,
  },
  duplicates: { title: 'Likely duplicate detection', effort: 'low', maxOutputTokens: 1024 },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureId = keyof typeof AI_FEATURES;

export interface ResolvedFeature {
  id: FeatureId;
  enabled: boolean;
  model: ClaudeModelId;
  effort: Effort;
  maxOutputTokens: number;
}

/** Applies an administrator's overrides to a feature's defaults. */
export function resolveFeature(id: FeatureId, settings?: FeatureSettings): ResolvedFeature {
  const spec = AI_FEATURES[id];
  return {
    id,
    enabled: settings?.enabled ?? true,
    model: settings?.model ?? DEFAULT_MODEL,
    effort: settings?.effort ?? spec.effort,
    maxOutputTokens: spec.maxOutputTokens,
  };
}

import { type ClaudeModelId, DEFAULT_MODEL, type Effort, type FeatureSettings } from './config';
import type { Capability } from './types';

export interface FeatureSpec {
  title: string;
  /** Reasoning depth, always sent explicitly (spec 02c section 1.2); admins can change it. */
  effort: Effort;
  /** Room for adaptive thinking as well as the answer: thinking counts against this limit. */
  maxOutputTokens: number;
  output: 'streamed-text' | 'structured';
  /** What the provider must offer for the feature to be shown at all. */
  needs: readonly Capability[];
}

/** Every AI feature the product offers, with its defaults. New features are added here first. */
export const AI_FEATURES = {
  summarize: {
    title: 'Summaries of tickets and threads',
    effort: 'low',
    maxOutputTokens: 16_000,
    output: 'streamed-text',
    needs: ['streaming'],
  },
  'query-from-text': {
    title: 'Plain-language search turned into a query',
    effort: 'low',
    maxOutputTokens: 16_000,
    output: 'structured',
    needs: ['structuredOutput'],
  },
  'assisted-creation': {
    title: 'Draft tickets from a description',
    effort: 'medium',
    maxOutputTokens: 16_000,
    output: 'structured',
    needs: ['structuredOutput'],
  },
  duplicates: {
    title: 'Likely duplicate detection',
    effort: 'low',
    maxOutputTokens: 16_000,
    output: 'structured',
    needs: ['structuredOutput'],
  },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureId = keyof typeof AI_FEATURES;

export interface ResolvedFeature {
  id: FeatureId;
  enabled: boolean;
  model: ClaudeModelId;
  effort: Effort;
  maxOutputTokens: number;
  needs: readonly Capability[];
}

/** Applies an administrator's overrides to a feature's defaults. */
export function resolveFeature(id: FeatureId, settings?: FeatureSettings): ResolvedFeature {
  const spec: FeatureSpec = AI_FEATURES[id];
  return {
    id,
    enabled: settings?.enabled ?? true,
    model: settings?.model ?? DEFAULT_MODEL,
    effort: settings?.effort ?? spec.effort,
    maxOutputTokens: spec.maxOutputTokens,
    needs: spec.needs,
  };
}

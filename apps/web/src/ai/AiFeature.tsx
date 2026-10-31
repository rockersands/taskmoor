import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api/client';

/** Why a feature is not offered (M1-076): `GET /api/v1/ai/features` gives one per feature. */
export type AiFeatureState =
  | { available: true }
  | {
      available: false;
      reason:
        | 'disabled'
        | 'not_configured'
        | 'invalid'
        | 'key_unreadable'
        | 'track_off'
        | 'strict'
        | 'feature_off'
        | 'unsupported';
    };

export type AiFeatures = Record<string, AiFeatureState>;

export const loadAiFeatures = (trackId?: number): Promise<AiFeatures> =>
  api<{ features: AiFeatures }>(
    trackId === undefined ? '/ai/features' : `/ai/features?trackId=${trackId}`,
  ).then((answer) => answer.features);

/**
 * Which AI features the person may use here (AI-001, AI-002 (2), IAM-019): every one is off
 * until the answer says otherwise, so an AI control never shows by mistake, also while it loads
 * or when the server cannot be asked.
 */
export function useAiFeatures(
  trackId: number | undefined,
  load: (trackId?: number) => Promise<AiFeatures> = loadAiFeatures,
): AiFeatures {
  const [features, setFeatures] = useState<AiFeatures>({});
  useEffect(() => {
    let live = true;
    load(trackId).then(
      (found) => live && setFeatures(found),
      () => live && setFeatures({}),
    );
    return () => {
      live = false;
    };
  }, [trackId, load]);
  return features;
}

/**
 * Shows its children only where the AI feature is available: AI switched on for the workspace
 * and the track (or the track opted in under strict mode), the feature on, and the provider able
 * to serve it. Every AI control in the app goes inside one; the server refuses the call anyway.
 */
export function AiFeature({
  feature,
  trackId,
  load,
  children,
}: {
  feature: string;
  trackId?: number;
  load?: (trackId?: number) => Promise<AiFeatures>;
  children: ReactNode;
}) {
  const features = useAiFeatures(trackId, load);
  return features[feature]?.available ? children : null;
}

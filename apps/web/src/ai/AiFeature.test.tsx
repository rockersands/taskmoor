import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AiFeature, type AiFeatures } from './AiFeature';

const answer =
  (features: AiFeatures, seen: (number | undefined)[] = []) =>
  async (trackId?: number) => {
    seen.push(trackId);
    return features;
  };

describe('AI controls (M1-076)', () => {
  it('[AI-001] shows an AI control only where the server says the feature is available', async () => {
    const seen: (number | undefined)[] = [];
    render(
      <>
        <AiFeature
          feature="summarize"
          trackId={7}
          load={answer({ summarize: { available: true } }, seen)}
        >
          <button type="button">Summarise</button>
        </AiFeature>
        <AiFeature
          feature="duplicates"
          load={answer({ duplicates: { available: false, reason: 'strict' } })}
        >
          <button type="button">Find duplicates</button>
        </AiFeature>
      </>,
    );
    expect(await screen.findByRole('button', { name: 'Summarise' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Find duplicates' })).toBeNull();
    expect(seen).toEqual([7]);
  });

  it('[IAM-019] keeps AI controls hidden while it loads and when the server cannot be asked', async () => {
    let fail: (e: Error) => void = () => {};
    render(
      <AiFeature
        feature="summarize"
        load={() =>
          new Promise<AiFeatures>((_, reject) => {
            fail = reject;
          })
        }
      >
        <button type="button">Summarise</button>
      </AiFeature>,
    );
    expect(screen.queryByRole('button', { name: 'Summarise' })).toBeNull();
    fail(new Error('offline'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Summarise' })).toBeNull();
  });
});

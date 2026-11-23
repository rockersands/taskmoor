// The prompt-injection corpus against a live model (M1-079; IAM-023; ADR-104; T-333): every case
// through the same agent run as injection.test.ts, with a real model in place of the obedient
// fake. The model may follow, refuse or ignore an injection; every case must hold all the same
// (`holdProblems`). Skipped unless TASKMOOR_AI_TEST_KEY holds a key; `pnpm ai:live` runs it with
// the key it asked for and reports how many cases held. The key comes from the environment only.
import { beforeAll, describe, expect, it } from 'vitest';
import { providerConfigSchema } from '../config';
import { createProviderAdapter } from '../factory';
import { InMemorySecretStore } from '../secrets';
import { recordLiveResult } from '../testing';
import type { ProviderAdapter } from '../types';
import { INJECTION_CASES } from './corpus';
import { followedInjection, holdProblems, playCase } from './harness';

const key = process.env.TASKMOOR_AI_TEST_KEY;
/** Another address for the API, such as the fake provider in `pnpm ai:live`'s own test. */
const baseUrl = process.env.TASKMOOR_AI_TEST_BASE_URL;

describe.skipIf(!key)('Prompt-injection corpus against a live model (M1-079)', () => {
  let adapter: ProviderAdapter;

  beforeAll(async () => {
    adapter = await createProviderAdapter(
      providerConfigSchema.parse({
        provider: 'anthropic',
        apiKey: { secretId: 'live' },
        ...(baseUrl ? { baseUrl } : {}),
      }),
      new InMemorySecretStore({ live: key ?? '' }),
      { timeoutMs: 120_000 },
    );
  });

  for (const c of INJECTION_CASES) {
    it(`[IAM-023] ${c.goal}: ${c.id} holds against the live model`, {
      timeout: 600_000,
    }, async () => {
      const played = await playCase(c, () => adapter, { maxSteps: 4, maxWallMs: 300_000 });
      const problems = holdProblems(played);
      // Nothing answered is nothing measured: a case holds only once the model has answered.
      if (played.report.steps.length === 0) {
        problems.push(`the model never answered (${played.report.status})`);
      }
      recordLiveResult('injection-case', {
        id: c.id,
        goal: c.goal,
        holds: problems.length === 0,
        problems,
        followed: followedInjection(c, played),
        status: played.report.status,
        steps: played.report.steps.length,
      });
      expect(problems).toEqual([]);
    });
  }
});

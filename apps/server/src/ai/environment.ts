import type { Database } from '@taskmoor/db';
import type { KeyRing } from '@taskmoor/iam';
import { type Kysely, sql } from 'kysely';
import { emit } from '../events/bus';
import { defaultWorkspaceId } from '../workspace';
import { storeCredential } from './credentials';
import {
  type CredentialSlot,
  type PROVIDER_IDS,
  type ProviderSettings,
  readAiSettings,
  withCredentialRefs,
  writeAiSettings,
} from './settings';

/**
 * The AI settings a headless install gives in its environment (AI-001 (3); IAM-020): the
 * Builder's backend kit writes `TASKMOOR_AI_PROVIDER` and `TASKMOOR_AI_KEY`; the platforms that
 * need more take `TASKMOOR_AI_REGION`, `_PROJECT`, `_RESOURCE`, `_BASE_URL` and `_MODEL`.
 */
export interface AiEnvironment {
  provider?: (typeof PROVIDER_IDS)[number] | undefined;
  key?: string | undefined;
  region?: string | undefined;
  project?: string | undefined;
  resource?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export type AiEnvironmentOutcome =
  | 'none'
  | 'imported'
  | 'ignored'
  | 'no_key_storage'
  | 'no_provider';

/** The slot the environment's key fills for each provider. */
const KEY_SLOT: Record<(typeof PROVIDER_IDS)[number], CredentialSlot> = {
  anthropic: 'apiKey',
  bedrock: 'apiKey',
  vertex: 'accessToken',
  foundry: 'apiKey',
  'openai-compatible': 'apiKey',
};

function providerFrom(env: AiEnvironment & { provider: (typeof PROVIDER_IDS)[number] }) {
  const settings: ProviderSettings = { provider: env.provider };
  if (env.provider === 'bedrock' || env.provider === 'vertex') {
    if (env.region) settings.region = env.region;
  }
  if (env.provider === 'vertex' && env.project) settings.projectId = env.project;
  if (env.provider === 'foundry' && env.resource) settings.resource = env.resource;
  if (env.provider === 'anthropic' && env.baseUrl) settings.baseUrl = env.baseUrl;
  if (env.provider === 'openai-compatible') {
    if (env.baseUrl) settings.baseUrl = env.baseUrl;
    if (env.model) settings.model = env.model;
  }
  return settings;
}

/**
 * On the first start with AI settings in the environment, moves them into the database: the
 * key sealed (IAM-020), the provider's settings beside it, AI switched on when they are
 * complete. Every later start ignores the environment and says so. Log lines name variables,
 * never a value. Several API processes may start at once: an advisory lock lets one do it.
 */
export async function importAiEnvironment(
  db: Kysely<Database>,
  ring: KeyRing,
  env: AiEnvironment,
  log: (entry: Record<string, unknown>) => void,
): Promise<AiEnvironmentOutcome> {
  if (!env.provider && !env.key) return 'none';
  const given = ['TASKMOOR_AI_PROVIDER', 'TASKMOOR_AI_KEY'].filter((_, i) =>
    i === 0 ? env.provider : env.key,
  );
  const workspaceId = await defaultWorkspaceId(db);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('taskmoor ai environment'))`.execute(trx);
    const current = await readAiSettings(trx, workspaceId);
    const stored = await trx
      .selectFrom('ai_credential')
      .select('slot')
      .where('workspace_id', '=', workspaceId)
      .execute();
    if (current.environmentImportedAt || current.settings.provider || stored.length > 0) {
      log({
        msg: 'AI settings in the environment are ignored: they are kept in the database (change them on the AI settings page); remove them from the environment file',
        variables: given,
      });
      return 'ignored';
    }
    if (!env.provider) {
      log({
        msg: 'TASKMOOR_AI_KEY is ignored without TASKMOOR_AI_PROVIDER',
        variables: given,
      });
      return 'no_provider';
    }
    if (env.key && !ring.active) {
      log({
        msg: 'TASKMOOR_AI_KEY cannot be stored: set TASKMOOR_MASTER_KEY (or TASKMOOR_DATA for a keyring); AI stays off',
      });
      return 'no_key_storage';
    }
    const provider = providerFrom({ ...env, provider: env.provider });
    const slot = KEY_SLOT[env.provider];
    if (env.key) {
      const stored = await storeCredential(trx, ring, {
        workspaceId,
        slot,
        value: env.key,
        source: 'environment',
        actorId: null,
      });
      await emit(
        trx,
        { workspaceId, actorId: null },
        {
          type: 'ai.credential_set',
          subjectId: workspaceId,
          payload: { slot, last4: stored.last4, replaced: false, source: 'environment' },
        },
      );
    }
    const resolved = withCredentialRefs(provider, env.key ? [slot] : []);
    await writeAiSettings(
      trx,
      workspaceId,
      null,
      { ...current.settings, enabled: resolved.ok, provider },
      { environmentImported: true },
    );
    if (!resolved.ok) {
      log({
        msg: 'AI settings from the environment are incomplete; AI stays off until they are completed on the AI settings page',
        provider: env.provider,
        problems: resolved.problems,
      });
    }
    log({
      msg: 'AI settings moved from the environment into the database, the key sealed; remove TASKMOOR_AI_KEY from the environment file',
      provider: env.provider,
      enabled: resolved.ok,
    });
    return 'imported';
  });
}

import {
  AI_FEATURES,
  type FeatureId,
  featureSettingsSchema,
  type ProviderConfig,
  type ProviderId,
  providerConfigSchema,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';

type Db = Kysely<Database> | Transaction<Database>;

/**
 * A workspace's AI settings (M1-075, M1-076; AI-001, IAM-020; ADR-098, ADR-099), kept in
 * `ai_setting.value`. The provider settings here never hold a secret: credentials live sealed in
 * `ai_credential`, one per slot, and the provider's references to them are added when its client
 * is built (`withCredentialRefs`).
 */
export const PROVIDER_IDS = [
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
  'openai-compatible',
] as const satisfies readonly ProviderId[];

/** The secret fields each provider's settings may take, in `ProviderConfig`'s own names. */
export const CREDENTIAL_SLOTS = [
  'apiKey',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  'accessToken',
] as const;
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

export const PROVIDER_SLOTS: Record<ProviderId, readonly CredentialSlot[]> = {
  anthropic: ['apiKey'],
  bedrock: ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken'],
  vertex: ['accessToken'],
  foundry: ['apiKey'],
  'openai-compatible': ['apiKey'],
};
/** Slots a provider cannot work without. */
export const REQUIRED_SLOTS: Record<ProviderId, readonly CredentialSlot[]> = {
  anthropic: ['apiKey'],
  bedrock: [],
  vertex: [],
  foundry: ['apiKey'],
  'openai-compatible': [],
};

/** The provider's settings without credentials: `ProviderConfig` minus its secret fields. */
export const providerSettings = z.looseObject({ provider: z.enum(PROVIDER_IDS) });
export type ProviderSettings = z.infer<typeof providerSettings>;

export const FEATURE_IDS = Object.keys(AI_FEATURES) as [FeatureId, ...FeatureId[]];

export const storedAiSettings = z.object({
  /** AI for the workspace at all (AI-001); off until a provider is set up. */
  enabled: z.boolean().default(false),
  /**
   * Strict mode (IAM-019, the AI part): AI only in tracks an administrator opted in; everywhere
   * else (other tracks, and anything outside a track) it is off and its controls hidden.
   */
  strict: z.boolean().default(false),
  provider: providerSettings.nullable().default(null),
  /** Per-feature switch, model and effort (AI-006); anything left out uses the feature's default. */
  features: z.record(z.string(), featureSettingsSchema).default({}),
  /** Track switches by track id: false turns AI off there; true opts it in under strict mode. */
  tracks: z.record(z.string(), z.boolean()).default({}),
});
export type StoredAiSettings = z.infer<typeof storedAiSettings>;

export const DEFAULT_AI_SETTINGS: StoredAiSettings = storedAiSettings.parse({});

export interface AiSettingsRow {
  settings: StoredAiSettings;
  version: number;
  environmentImportedAt: Date | null;
  updatedAt: Date | null;
}

export async function readAiSettings(db: Db, workspaceId: number): Promise<AiSettingsRow> {
  const row = await db
    .selectFrom('ai_setting')
    .select(['value', 'version', 'environment_imported_at', 'updated_at'])
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  const parsed = storedAiSettings.safeParse(row?.value ?? {});
  return {
    settings: parsed.success ? parsed.data : DEFAULT_AI_SETTINGS,
    version: row?.version ?? 0,
    environmentImportedAt: row?.environment_imported_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * Writes the settings (or only moves the version, for a credential change) and returns the new
 * version. Every process builds its provider client again at its next call.
 */
export async function writeAiSettings(
  db: Db,
  workspaceId: number,
  actorId: number | null,
  settings?: StoredAiSettings,
  options: { environmentImported?: boolean } = {},
): Promise<number> {
  const value = settings ? JSON.stringify(settings) : undefined;
  const row = await db
    .insertInto('ai_setting')
    .values({
      workspace_id: workspaceId,
      value: value ?? JSON.stringify(DEFAULT_AI_SETTINGS),
      updated_by: actorId,
      ...(options.environmentImported ? { environment_imported_at: sql<Date>`now()` } : {}),
    })
    .onConflict((oc) =>
      oc.column('workspace_id').doUpdateSet({
        version: sql<number>`ai_setting.version + 1`,
        updated_by: actorId,
        updated_at: sql<Date>`now()`,
        ...(value !== undefined ? { value } : {}),
        ...(options.environmentImported ? { environment_imported_at: sql<Date>`now()` } : {}),
      }),
    )
    .returning('version')
    .executeTakeFirstOrThrow();
  return row.version;
}

/**
 * The full provider configuration: the stored settings plus a reference to each slot that holds
 * a credential the provider takes. Problems are paths and Zod's messages, never values.
 */
export function withCredentialRefs(
  provider: ProviderSettings,
  slots: Iterable<CredentialSlot>,
): { ok: true; config: ProviderConfig } | { ok: false; problems: string[] } {
  const refs: Record<string, { secretId: string }> = {};
  const offered = new Set(PROVIDER_SLOTS[provider.provider]);
  for (const slot of slots) if (offered.has(slot)) refs[slot] = { secretId: slot };
  const parsed = providerConfigSchema.safeParse({ ...provider, ...refs });
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'provider'}: ${i.message}`),
  };
}

/** What an administrator saves on the AI settings page (M1-076): everything but the tracks. */
export const aiSettingsInput = z
  .object({
    enabled: z.boolean(),
    strict: z.boolean(),
    provider: providerSettings.nullable(),
    features: z.partialRecord(z.enum(FEATURE_IDS), featureSettingsSchema.strict()).default({}),
  })
  .strict();
export type AiSettingsInput = z.infer<typeof aiSettingsInput>;

/**
 * Checks provider settings an administrator saves: no secret in them (keys go through the
 * credential routes, write-only) and complete once the provider's required keys are stored.
 * Problems are field paths and rules, never values.
 */
export function checkProvider(provider: ProviderSettings): string[] {
  const secret = CREDENTIAL_SLOTS.filter((slot) => Object.hasOwn(provider, slot));
  if (secret.length > 0) return secret.map((slot) => `${slot}: set keys on their own route`);
  const resolved = withCredentialRefs(provider, REQUIRED_SLOTS[provider.provider]);
  return resolved.ok ? [] : resolved.problems;
}

/**
 * Changes the settings under the row's lock, so two administrators' changes (a track switch
 * and a save) never undo each other. Returns the settings before and after.
 */
export async function updateAiSettings(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  change: (current: StoredAiSettings) => StoredAiSettings,
): Promise<{ before: StoredAiSettings; after: StoredAiSettings; version: number }> {
  await trx
    .insertInto('ai_setting')
    .values({ workspace_id: workspaceId, value: JSON.stringify(DEFAULT_AI_SETTINGS) })
    .onConflict((oc) => oc.column('workspace_id').doNothing())
    .execute();
  const row = await trx
    .selectFrom('ai_setting')
    .select('value')
    .where('workspace_id', '=', workspaceId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const parsed = storedAiSettings.safeParse(row.value);
  const before = parsed.success ? parsed.data : DEFAULT_AI_SETTINGS;
  const after = change(before);
  const version = await writeAiSettings(trx, workspaceId, actorId, after);
  return { before, after, version };
}

export type AiBlock = 'disabled' | 'track_off' | 'strict';

/**
 * Whether the workspace and track let AI run (AI-001, IAM-019): off for the workspace, off for
 * the track, or strict mode with the track not opted in (or no track at all). Null: it may.
 */
export function scopeBlock(settings: StoredAiSettings, trackId?: number | null): AiBlock | null {
  if (!settings.enabled) return 'disabled';
  const explicit = trackId != null ? settings.tracks[String(trackId)] : undefined;
  if (explicit === false) return 'track_off';
  if (settings.strict && explicit !== true) return 'strict';
  return null;
}

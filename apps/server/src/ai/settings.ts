import { type ProviderConfig, type ProviderId, providerConfigSchema } from '@taskmoor/ai';
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

export const storedAiSettings = z.object({
  /** AI for the workspace at all (AI-001); off until a provider is set up. */
  enabled: z.boolean().default(false),
  provider: providerSettings.nullable().default(null),
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

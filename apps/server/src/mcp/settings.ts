import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';

/**
 * The MCP server's settings (M1-072; API-012; ADR-068), kept in `instance_setting` under `mcp`:
 * whether it answers at all, which clients may connect (by the name they give in `initialize`;
 * none listed means any), and the tool profile every connection gets.
 *
 * - `read-only`: search and read tickets; list tracks, boards and sprints.
 * - `planner`: also create and change tickets, comment and link (the default).
 * - `full`: also move tickets through their transitions.
 *
 * `oauthRegistration` (M1-072; ADR-084): whether MCP clients may register themselves for OAuth.
 * Each one still needs a person's consent before it acts for them.
 */
export const MCP_PROFILES = ['read-only', 'planner', 'full'] as const;
export type McpProfile = (typeof MCP_PROFILES)[number];

export const mcpSettingsInput = z
  .object({
    enabled: z.boolean(),
    allowedClients: z.array(z.string().trim().min(1).max(100)).max(100),
    profile: z.enum(MCP_PROFILES),
    oauthRegistration: z.boolean().default(true),
  })
  .strict();
export type McpSettings = z.infer<typeof mcpSettingsInput>;

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: true,
  allowedClients: [],
  profile: 'planner',
  oauthRegistration: true,
};
const KEY = 'mcp';

export async function readMcpSettings(db: Kysely<Database>): Promise<McpSettings> {
  const row = await db
    .selectFrom('instance_setting')
    .select('value')
    .where('key', '=', KEY)
    .executeTakeFirst();
  const parsed = mcpSettingsInput.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_MCP_SETTINGS;
}

export async function writeMcpSettings(
  db: Kysely<Database> | Transaction<Database>,
  settings: McpSettings,
): Promise<void> {
  const value = JSON.stringify(settings);
  await db
    .insertInto('instance_setting')
    .values({ key: KEY, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: sql`now()` }))
    .execute();
}

/** Whether a client, by the name it gave, may connect. */
export function clientAllowed(settings: McpSettings, name: string): boolean {
  if (settings.allowedClients.length === 0) return true;
  const wanted = name.trim().toLowerCase();
  return settings.allowedClients.some((c) => c.toLowerCase() === wanted);
}

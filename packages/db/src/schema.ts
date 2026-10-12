import type { ColumnType, Generated } from 'kysely';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSONB columns read as parsed values and are written as JSON text. Passing text avoids the pg
 * driver turning JS arrays into Postgres arrays.
 */
export type Json = ColumnType<JsonValue, string, string>;

/** Timestamps read as Date and accept Date or ISO text on write. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** Instance-wide key/value settings (setup state, feature switches, public metadata). */
export interface InstanceSettingTable {
  key: string;
  value: Json;
  updated_at: DefaultTimestamp;
}

/** People who can sign in. Email is stored lower-cased; the hash format is the iam package's. */
export interface AppUserTable {
  id: Generated<number>;
  email: string;
  name: string;
  password_hash: string | null;
  is_site_admin: Generated<boolean>;
  created_at: DefaultTimestamp;
  deactivated_at: Timestamp | null;
}

/** Server-side sessions referenced by the session cookie (ADR-032); revocable by row. */
export interface SessionTable {
  id: string;
  user_id: number;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  last_seen_at: DefaultTimestamp;
}

/** Every table Kysely knows about. Add a table here in the same change as its migration. */
export interface Database {
  instance_setting: InstanceSettingTable;
  app_user: AppUserTable;
  session: SessionTable;
}

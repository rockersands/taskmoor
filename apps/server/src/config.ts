import type { S3StoreConfig } from '@taskmoor/storage';
import { DEV_VERSION, ROUTING_MODES, type RoutingMode } from '@taskmoor/webconfig';
import { z } from 'zod';
import { frontendOrigin } from './network/frontends';

/** Stamped into the bundle by `pnpm build` from TASKMOOR_VERSION, as the frontend artefact is. */
declare const __TASKMOOR_BUILD_VERSION__: string | undefined;
const BUILT_VERSION =
  typeof __TASKMOOR_BUILD_VERSION__ === 'string' ? __TASKMOOR_BUILD_VERSION__ : DEV_VERSION;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * What one process does (ADR-021). One image serves every role; `TASKMOOR_ROLE` picks one or
 * several (comma-separated), and `all` (the default) runs everything in one process, which is
 * what a small install wants.
 */
export const ROLES = ['api', 'worker', 'realtime', 'web'] as const;
export type Role = (typeof ROLES)[number];

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL')
    .optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Defaults to the version the bundle was built with; the frontend artefact must match it. */
  TASKMOOR_VERSION: z.string().min(1).default(BUILT_VERSION),
  TASKMOOR_ROLE: z.string().min(1).default('all'),
  /** Directory with the built frontend, served by the web role; unset means no static files. */
  TASKMOOR_WEB_DIR: z.string().min(1).optional(),
  /**
   * How the served frontend writes its addresses (M1-105): `hash` (#/boards/7) or `path`
   * (clean URLs, /boards/7); either way links of the other kind still open.
   */
  TASKMOOR_WEB_ROUTING: z.enum(ROUTING_MODES as [RoutingMode, ...RoutingMode[]]).default('hash'),
  /** Where browsers reach this instance; the setup link and cookie security follow it. */
  PUBLIC_URL: z.string().url().optional(),
  /**
   * Frontends on other origins (M1-107, ADR-080), comma-separated exact origins such as
   * https://tracker.example.com: they get CORS answers, may open WebSockets and may sign in
   * through OAuth. The Builder's backend kit writes it. Unset, only this instance's own origin
   * is let in.
   */
  TASKMOOR_ALLOWED_ORIGINS: z.string().min(1).optional(),
  /**
   * Where OAuth sign-in may send a frontend back, comma-separated exact URLs on allowed
   * origins (the Builder writes the frontend's URL). Unset, each allowed origin's root.
   */
  TASKMOOR_OAUTH_REDIRECT_URIS: z.string().min(1).optional(),
  /** Fixed setup token for installers and tests; otherwise one is generated per start. */
  TASKMOOR_SETUP_TOKEN: z.string().min(16).optional(),
  /** Files, backups and the backup marker (ADR-021); the image sets /data. */
  TASKMOOR_DATA: z.string().min(1).optional(),
  /**
   * Where scheduled backups go (M1-101); defaults to TASKMOOR_DATA/backups. `off` keeps this
   * process from taking them (a worker without a persistent volume).
   */
  TASKMOOR_BACKUP_DIR: z.string().min(1).optional(),
  /**
   * Where import files on the server live (M1-098): CSV files and Taskmoor exports an import
   * names by path must be inside it. Defaults to TASKMOOR_DATA/imports; `off` refuses paths.
   */
  TASKMOOR_IMPORT_DIR: z.string().min(1).optional(),
  /** Internal Prometheus port (ADR-023); 0 turns the metrics listener off. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  TASKMOOR_SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(2000),
  /** Address of the metrics listener; defaults to HOST. */
  METRICS_HOST: z.string().min(1).optional(),
  /**
   * Reverse proxies whose X-Forwarded-For header is believed, comma-separated: addresses,
   * CIDRs or the names loopback, linklocal, uniquelocal. Sign-in rate limits count per client
   * address, so set this whenever a proxy sits in front; unset, the socket peer is the client.
   */
  TASKMOOR_TRUSTED_PROXIES: z.string().min(1).optional(),
  /**
   * The active password pepper (ASVS 2.4.5), 32 characters or more. Unset, the install keeps
   * its keyring in TASKMOOR_DATA/secrets/password-peppers (created on first start).
   */
  TASKMOOR_PASSWORD_PEPPER: z.string().min(32).optional(),
  /**
   * The instance's identity from the Builder's backend kit (M1-109, ADR-070): its id and its
   * Ed25519 key's 32-byte seed in base64url. They seed the identity the meta endpoint serves the
   * first time it is needed; an identity already stored (a restore) is kept.
   */
  TASKMOOR_INSTANCE_ID: z.string().uuid().optional(),
  TASKMOOR_INSTANCE_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'must be 32 bytes in base64url, as the Builder writes it')
    .optional(),
  /**
   * Attachments (M1-016, ADR-040): `local` (files under TASKMOOR_FILES_DIR, by default
   * TASKMOOR_DATA/files) or `s3` (a bucket). Defaults to s3 when a bucket is named.
   */
  TASKMOOR_STORAGE: z.enum(['local', 's3']).optional(),
  /** `off`: no local store in this process (a worker without the app's volume). */
  TASKMOOR_FILES_DIR: z.string().min(1).optional(),
  TASKMOOR_S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a bucket name')
    .optional(),
  TASKMOOR_S3_REGION: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/, 'must be a region name')
    .default('us-east-1'),
  /** For S3-compatible stores (MinIO, Garage, Ceph, R2); unset for AWS. */
  TASKMOOR_S3_ENDPOINT: z.string().url().optional(),
  /** What browsers reach the store at, when it differs from the endpoint; signed URLs use it. */
  TASKMOOR_S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  TASKMOOR_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
  TASKMOOR_S3_PREFIX: z
    .string()
    .regex(/^([A-Za-z0-9._-]+\/)+$/, 'must be folder names ending in "/"')
    .optional(),
  /** Both or neither; unset, the AWS default chain applies (instance role, IRSA, profile). */
  TASKMOOR_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  TASKMOOR_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  TASKMOOR_S3_SESSION_TOKEN: z.string().min(1).optional(),
  TASKMOOR_S3_SSE: z.enum(['AES256', 'aws:kms']).optional(),
  TASKMOOR_S3_SSE_KMS_KEY_ID: z.string().min(1).optional(),
  /** Seconds a signed download URL lives: short (default 5 minutes, at most an hour). */
  TASKMOOR_S3_URL_TTL: z.coerce.number().int().min(10).max(3600).default(300),
  /** ClamAV's daemon for the scan hook: host:port, tcp://host:port or unix:/path. */
  TASKMOOR_SCAN_CLAMD: z.string().min(1).optional(),
  /**
   * Email notifications (M1-057): the SMTP server as smtp://host:port (STARTTLS when offered)
   * or smtps://host:port (TLS from the start). Unset, notifications wait for it unsent.
   */
  TASKMOOR_SMTP_URL: z
    .string()
    .regex(/^smtps?:\/\/[^/@]+$/, 'must be smtp://host:port or smtps://host:port, no credentials')
    .optional(),
  /** The sign-in for the SMTP server; the password only ever comes from the environment. */
  TASKMOOR_SMTP_USER: z.string().min(1).optional(),
  TASKMOOR_SMTP_PASSWORD: z.string().min(1).optional(),
  /** The From address of notification emails. */
  TASKMOOR_SMTP_FROM: z.string().min(3).optional(),
  /** How long one search statement may run (QRY-010 (3)), in milliseconds. */
  TASKMOOR_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  /** The Jira-compatible API under /rest (M1-069, ADR-086): on unless `off`. */
  TASKMOOR_JIRA_COMPAT: z.enum(['on', 'off']).default('on'),
});

export interface ServerConfig {
  /** Required unless the process only serves the frontend (role `web`). */
  databaseUrl: string | undefined;
  port: number;
  host: string;
  logLevel: (typeof LOG_LEVELS)[number];
  version: string;
  roles: readonly Role[];
  webDir: string | undefined;
  webRouting: RoutingMode;
  publicUrl: string;
  secureCookies: boolean;
  /** Frontend origins besides this instance's own (TASKMOOR_ALLOWED_ORIGINS). */
  allowedOrigins: string[];
  /** Where OAuth sign-in may return (TASKMOOR_OAUTH_REDIRECT_URIS or each allowed origin's root). */
  oauthRedirectUris: string[];
  setupToken: string | undefined;
  dataDir: string | undefined;
  /** Scheduled backups' directory as configured: a path, `off`, or unset for the default. */
  backupDir: string | undefined;
  /** Where imports read files named by path; undefined when there is none. */
  importDir: string | undefined;
  /** 0 when the metrics listener is off. */
  metricsPort: number;
  metricsHost: string;
  trustedProxies: string | undefined;
  passwordPepper: string | undefined;
  /** The identity a Builder kit gives the instance (TASKMOOR_INSTANCE_ID and _KEY). */
  instance: { id: string; seed: string } | undefined;
  /**
   * After SIGTERM, how long the server keeps answering (each answer closing its connection)
   * before it stops: keep-alive clients hang up cleanly instead of losing a request.
   */
  shutdownDrainMs: number;
  /** Attachments (M1-016, ADR-040). */
  storage: StorageConfig;
  /** Email notifications (M1-057); undefined when no SMTP server is configured. */
  smtp: SmtpConfig | undefined;
  /**
   * TASKMOOR_SMTP_PASSWORD, also when the server comes from the first-run setup form instead
   * of TASKMOOR_SMTP_URL (the form never asks for the password).
   */
  smtpPassword: string | undefined;
  /** Milliseconds a search statement may run before it is stopped (QRY-010 (3)). */
  queryTimeoutMs: number;
  /** Whether the Jira-compatible API is served (M1-069). */
  jiraCompat: boolean;
}

export interface SmtpConfig {
  url: string;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

export interface StorageConfig {
  /** Where new files go; unset means s3 when a bucket is configured, else local. */
  backend: 'local' | 's3' | undefined;
  /** The local store's directory as configured: a path, `off`, or unset for TASKMOOR_DATA/files. */
  filesDir: string | undefined;
  s3: S3StoreConfig | undefined;
  urlTtl: number;
  scanClamd: string | undefined;
}

export function parseRoles(text: string): Role[] {
  const names = text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes('all')) return [...ROLES];
  const unknown = names.filter((n) => !(ROLES as readonly string[]).includes(n));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(
      `TASKMOOR_ROLE must be "all" or a comma-separated list of ${ROLES.join(', ')}` +
        (unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''),
    );
  }
  return ROLES.filter((r) => names.includes(r));
}

/**
 * TASKMOOR_ALLOWED_ORIGINS as origins (scheme, host and port, nothing else): https, or http for
 * this machine, no wildcards. Throws naming the entry that is not one; origins are public, so
 * they may be shown. The same rule as an administrator's list (M1-108).
 */
export function parseAllowedOrigins(text: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of (text ?? '').split(',').map((s) => s.trim())) {
    if (!entry) continue;
    const origin = frontendOrigin(entry);
    if (!origin) {
      throw new Error(
        `Invalid server configuration:\n- TASKMOOR_ALLOWED_ORIGINS must list origins such as https://tracker.example.com (plain http only for localhost): ${entry}`,
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** TASKMOOR_OAUTH_REDIRECT_URIS: exact URLs on allowed origins, without a fragment. */
export function parseRedirectUris(text: string | undefined, origins: readonly string[]): string[] {
  if (text === undefined) return origins.map((o) => `${o}/`);
  const uris: string[] = [];
  for (const entry of text.split(',').map((s) => s.trim())) {
    if (!entry) continue;
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {
      url = undefined;
    }
    if (!url || url.hash || url.username || url.password || !origins.includes(url.origin)) {
      throw new Error(
        `Invalid server configuration:\n- TASKMOOR_OAUTH_REDIRECT_URIS must list URLs on the allowed origins, without a fragment: ${entry}`,
      );
    }
    if (!uris.includes(url.href)) uris.push(url.href);
  }
  return uris;
}

/**
 * Reads server settings from environment variables. Errors name the variable and the rule it
 * broke but never echo the value, because DATABASE_URL can hold a password.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  // Compose and systemd pass unset variables as empty strings; those mean "not set".
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(given);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`);
    throw new Error(`Invalid server configuration:\n- ${problems.join('\n- ')}`);
  }
  const e = parsed.data;
  const roles = parseRoles(e.TASKMOOR_ROLE);
  const needsDatabase = roles.some((r) => r !== 'web');
  if (needsDatabase && !e.DATABASE_URL) {
    throw new Error(
      `Invalid server configuration:\n- DATABASE_URL is required for the ${roles.join(', ')} role(s)`,
    );
  }
  if (Boolean(e.TASKMOOR_S3_ACCESS_KEY_ID) !== Boolean(e.TASKMOOR_S3_SECRET_ACCESS_KEY)) {
    throw new Error(
      'Invalid server configuration:\n- TASKMOOR_S3_ACCESS_KEY_ID and TASKMOOR_S3_SECRET_ACCESS_KEY go together',
    );
  }
  if (Boolean(e.TASKMOOR_INSTANCE_ID) !== Boolean(e.TASKMOOR_INSTANCE_KEY)) {
    throw new Error(
      'Invalid server configuration:\n- TASKMOOR_INSTANCE_ID and TASKMOOR_INSTANCE_KEY go together',
    );
  }
  // A password alone serves the user the setup form saved; with TASKMOOR_SMTP_URL both go here.
  if (
    (e.TASKMOOR_SMTP_USER && !e.TASKMOOR_SMTP_PASSWORD) ||
    (e.TASKMOOR_SMTP_URL && e.TASKMOOR_SMTP_PASSWORD && !e.TASKMOOR_SMTP_USER)
  ) {
    throw new Error(
      'Invalid server configuration:\n- TASKMOOR_SMTP_USER and TASKMOOR_SMTP_PASSWORD go together',
    );
  }
  if (e.TASKMOOR_STORAGE === 's3' && !e.TASKMOOR_S3_BUCKET) {
    throw new Error(
      'Invalid server configuration:\n- TASKMOOR_STORAGE=s3 needs TASKMOOR_S3_BUCKET',
    );
  }
  const allowedOrigins = parseAllowedOrigins(e.TASKMOOR_ALLOWED_ORIGINS);
  const oauthRedirectUris = parseRedirectUris(e.TASKMOOR_OAUTH_REDIRECT_URIS, allowedOrigins);
  const s3: S3StoreConfig | undefined = e.TASKMOOR_S3_BUCKET
    ? {
        bucket: e.TASKMOOR_S3_BUCKET,
        region: e.TASKMOOR_S3_REGION,
        ...(e.TASKMOOR_S3_ENDPOINT ? { endpoint: e.TASKMOOR_S3_ENDPOINT } : {}),
        ...(e.TASKMOOR_S3_PUBLIC_ENDPOINT ? { publicEndpoint: e.TASKMOOR_S3_PUBLIC_ENDPOINT } : {}),
        // S3-compatible stores mostly want path-style addressing; AWS prefers virtual hosts.
        forcePathStyle: e.TASKMOOR_S3_FORCE_PATH_STYLE
          ? e.TASKMOOR_S3_FORCE_PATH_STYLE === 'true'
          : Boolean(e.TASKMOOR_S3_ENDPOINT),
        prefix: e.TASKMOOR_S3_PREFIX ?? '',
        ...(e.TASKMOOR_S3_ACCESS_KEY_ID && e.TASKMOOR_S3_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: e.TASKMOOR_S3_ACCESS_KEY_ID,
                secretAccessKey: e.TASKMOOR_S3_SECRET_ACCESS_KEY,
                ...(e.TASKMOOR_S3_SESSION_TOKEN
                  ? { sessionToken: e.TASKMOOR_S3_SESSION_TOKEN }
                  : {}),
              },
            }
          : {}),
        ...(e.TASKMOOR_S3_SSE ? { serverSideEncryption: e.TASKMOOR_S3_SSE } : {}),
        ...(e.TASKMOOR_S3_SSE_KMS_KEY_ID ? { kmsKeyId: e.TASKMOOR_S3_SSE_KMS_KEY_ID } : {}),
      }
    : undefined;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    version: e.TASKMOOR_VERSION,
    roles,
    webDir: e.TASKMOOR_WEB_DIR,
    webRouting: e.TASKMOOR_WEB_ROUTING,
    publicUrl: e.PUBLIC_URL ?? `http://localhost:${e.PORT}`,
    secureCookies: (e.PUBLIC_URL ?? '').startsWith('https://'),
    allowedOrigins,
    oauthRedirectUris,
    setupToken: e.TASKMOOR_SETUP_TOKEN,
    dataDir: e.TASKMOOR_DATA,
    backupDir: e.TASKMOOR_BACKUP_DIR,
    importDir:
      e.TASKMOOR_IMPORT_DIR === 'off'
        ? undefined
        : (e.TASKMOOR_IMPORT_DIR ?? (e.TASKMOOR_DATA ? `${e.TASKMOOR_DATA}/imports` : undefined)),
    metricsPort: e.METRICS_PORT,
    metricsHost: e.METRICS_HOST ?? e.HOST,
    trustedProxies: e.TASKMOOR_TRUSTED_PROXIES,
    passwordPepper: e.TASKMOOR_PASSWORD_PEPPER,
    instance:
      e.TASKMOOR_INSTANCE_ID && e.TASKMOOR_INSTANCE_KEY
        ? { id: e.TASKMOOR_INSTANCE_ID, seed: e.TASKMOOR_INSTANCE_KEY }
        : undefined,
    shutdownDrainMs: e.TASKMOOR_SHUTDOWN_DRAIN_MS,
    queryTimeoutMs: e.TASKMOOR_QUERY_TIMEOUT_MS,
    jiraCompat: e.TASKMOOR_JIRA_COMPAT === 'on',
    storage: {
      backend: e.TASKMOOR_STORAGE,
      filesDir: e.TASKMOOR_FILES_DIR,
      s3,
      urlTtl: e.TASKMOOR_S3_URL_TTL,
      scanClamd: e.TASKMOOR_SCAN_CLAMD,
    },
    smtp: e.TASKMOOR_SMTP_URL
      ? {
          url: e.TASKMOOR_SMTP_URL,
          user: e.TASKMOOR_SMTP_USER,
          password: e.TASKMOOR_SMTP_PASSWORD,
          from:
            e.TASKMOOR_SMTP_FROM ??
            `Taskmoor <taskmoor@${new URL(e.PUBLIC_URL ?? 'http://localhost').hostname}>`,
        }
      : undefined,
    smtpPassword: e.TASKMOOR_SMTP_PASSWORD,
  };
}

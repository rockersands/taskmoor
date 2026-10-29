import type { S3StoreConfig } from '@taskmoor/storage';
import { z } from 'zod';

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
  TASKMOOR_VERSION: z.string().min(1).default('0.0.0-dev'),
  TASKMOOR_ROLE: z.string().min(1).default('all'),
  /** Directory with the built frontend, served by the web role; unset means no static files. */
  TASKMOOR_WEB_DIR: z.string().min(1).optional(),
  /** Where browsers reach this instance; the setup link and cookie security follow it. */
  PUBLIC_URL: z.string().url().optional(),
  /** Fixed setup token for installers and tests; otherwise one is generated per start. */
  TASKMOOR_SETUP_TOKEN: z.string().min(16).optional(),
  /** Files, backups and the backup marker (ADR-021); the image sets /data. */
  TASKMOOR_DATA: z.string().min(1).optional(),
  /**
   * Where scheduled backups go (M1-101); defaults to TASKMOOR_DATA/backups. `off` keeps this
   * process from taking them (a worker without a persistent volume).
   */
  TASKMOOR_BACKUP_DIR: z.string().min(1).optional(),
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
  publicUrl: string;
  secureCookies: boolean;
  setupToken: string | undefined;
  dataDir: string | undefined;
  /** Scheduled backups' directory as configured: a path, `off`, or unset for the default. */
  backupDir: string | undefined;
  /** 0 when the metrics listener is off. */
  metricsPort: number;
  metricsHost: string;
  trustedProxies: string | undefined;
  passwordPepper: string | undefined;
  /**
   * After SIGTERM, how long the server keeps answering (each answer closing its connection)
   * before it stops: keep-alive clients hang up cleanly instead of losing a request.
   */
  shutdownDrainMs: number;
  /** Attachments (M1-016, ADR-040). */
  storage: StorageConfig;
  /** Email notifications (M1-057); undefined when no SMTP server is configured. */
  smtp: SmtpConfig | undefined;
  /** Milliseconds a search statement may run before it is stopped (QRY-010 (3)). */
  queryTimeoutMs: number;
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
  if (Boolean(e.TASKMOOR_SMTP_USER) !== Boolean(e.TASKMOOR_SMTP_PASSWORD)) {
    throw new Error(
      'Invalid server configuration:\n- TASKMOOR_SMTP_USER and TASKMOOR_SMTP_PASSWORD go together',
    );
  }
  if (e.TASKMOOR_STORAGE === 's3' && !e.TASKMOOR_S3_BUCKET) {
    throw new Error(
      'Invalid server configuration:\n- TASKMOOR_STORAGE=s3 needs TASKMOOR_S3_BUCKET',
    );
  }
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
    publicUrl: e.PUBLIC_URL ?? `http://localhost:${e.PORT}`,
    secureCookies: (e.PUBLIC_URL ?? '').startsWith('https://'),
    setupToken: e.TASKMOOR_SETUP_TOKEN,
    dataDir: e.TASKMOOR_DATA,
    backupDir: e.TASKMOOR_BACKUP_DIR,
    metricsPort: e.METRICS_PORT,
    metricsHost: e.METRICS_HOST ?? e.HOST,
    trustedProxies: e.TASKMOOR_TRUSTED_PROXIES,
    passwordPepper: e.TASKMOOR_PASSWORD_PEPPER,
    shutdownDrainMs: e.TASKMOOR_SHUTDOWN_DRAIN_MS,
    queryTimeoutMs: e.TASKMOOR_QUERY_TIMEOUT_MS,
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
  };
}

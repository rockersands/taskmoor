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
  };
}

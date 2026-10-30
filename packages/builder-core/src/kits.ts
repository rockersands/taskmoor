import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from '@taskmoor/webconfig';
import { canonicalJson } from './bytes';
import {
  apiOrigin,
  type BuilderInputs,
  basePath,
  frontendOrigin,
  type UserSecrets,
} from './inputs';
import {
  type ConnectionManifest,
  describeConnection,
  type SignedManifest,
  signManifest,
  verifyManifest,
} from './manifest';
import { type GeneratedSecrets, instancePublicKey, secretValues } from './secrets';
import { writeZip } from './zip';

/**
 * Both kits from one form (M1-109; OPS-014, ADR-031). This is the core every kit shares: the
 * backend's environment with its secrets and the frontend's public configuration, each with the
 * same signed connection manifest. M1-110 adds the Compose, Caddy and installer files and M1-111
 * the static app around these; both build on `buildKits`. Files are text, keyed by path, so the
 * same inputs and secrets always give the same bytes.
 */
export const MANIFEST_FILE = 'connection-manifest.json';
export const ENV_FILE = '.env';
export const CONFIG_FILE = 'taskmoor-config.json';

export interface Kits {
  manifest: SignedManifest;
  backend: Record<string, string>;
  frontend: Record<string, string>;
}

const envLine = (key: string, value: string) => {
  // Values are generated or validated; quote only what a shell or Compose would split.
  if (/[\s#"'$`\\]/.test(value)) throw new Error(`${key} cannot go into .env as it is`);
  return `${key}=${value}`;
};

function backendEnv(
  inputs: BuilderInputs,
  secrets: GeneratedSecrets,
  user: UserSecrets,
  manifest: ConnectionManifest,
): string {
  const lines = [
    '# Written by the Taskmoor Builder. Keep this file private: it holds the instance secrets.',
    // No TASKMOOR_VERSION: the image stamps its own, and the backend kit pins the image tag.
    envLine('PUBLIC_URL', apiOrigin(inputs)),
    envLine('TASKMOOR_ALLOWED_ORIGINS', manifest.frontendOrigins.join(',')),
    envLine('TASKMOOR_WEB_ROUTING', inputs.routing),
    envLine('TASKMOOR_INSTANCE_ID', secrets.instanceId),
    envLine('TASKMOOR_INSTANCE_KEY', secrets.instanceKey.seed),
    envLine('POSTGRES_PASSWORD', secrets.databasePassword),
    envLine('TASKMOOR_PASSWORD_PEPPER', secrets.passwordPepper),
    envLine('TASKMOOR_TOKEN_SIGNING_KEY', secrets.tokenSigningKey),
    envLine('TASKMOOR_MASTER_KEY', secrets.masterKey),
    envLine('TASKMOOR_SETUP_TOKEN', secrets.setupToken),
  ];
  if (inputs.smtp) {
    const scheme = inputs.smtp.port === 465 ? 'smtps' : 'smtp';
    lines.push(envLine('TASKMOOR_SMTP_URL', `${scheme}://${inputs.smtp.host}:${inputs.smtp.port}`));
    if (inputs.smtp.user) lines.push(envLine('TASKMOOR_SMTP_USER', inputs.smtp.user));
    if (user.smtpPassword) lines.push(envLine('TASKMOOR_SMTP_PASSWORD', user.smtpPassword));
    if (inputs.smtp.from) lines.push(envLine('TASKMOOR_SMTP_FROM', inputs.smtp.from));
  }
  if (inputs.ai) {
    lines.push(envLine('TASKMOOR_AI_PROVIDER', inputs.ai.provider));
    if (user.aiKey) lines.push(envLine('TASKMOOR_AI_KEY', user.aiKey));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The frontend's public runtime configuration, the keys of the slot in index.html (ADR-066),
 * pinned to the manifest's instance so the app checks it reached that backend (M1-111).
 */
export function frontendConfig(inputs: BuilderInputs, manifest: ConnectionManifest): RuntimeConfig {
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    apiUrl: apiOrigin(inputs) === frontendOrigin(inputs) ? '' : apiOrigin(inputs),
    routing: inputs.routing,
    basePath: basePath(inputs),
    instanceName: inputs.instanceName,
    instanceId: manifest.instanceId,
    instanceKey: manifest.publicKey,
  };
}

const json = (value: unknown) => `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

export async function buildKits(
  inputs: BuilderInputs,
  secrets: GeneratedSecrets,
  user: UserSecrets,
  versions: { backendVersion: string; kitVersion: string },
): Promise<Kits> {
  const manifest = await signManifest(
    describeConnection(inputs, secrets, versions),
    secrets.instanceKey.seed,
  );
  const kits: Kits = {
    manifest,
    backend: {
      [ENV_FILE]: backendEnv(inputs, secrets, user, manifest.manifest),
      [MANIFEST_FILE]: json(manifest),
    },
    frontend: {
      [CONFIG_FILE]: json(frontendConfig(inputs, manifest.manifest)),
      [MANIFEST_FILE]: json(manifest),
    },
  };
  const problems = await checkKits(kits, secrets, user);
  if (problems.length > 0) throw new Error(`The kits do not agree: ${problems.join('; ')}`);
  return kits;
}

/** A kit as a zip archive, the same bytes for the same files. */
export const zipKit = (files: Record<string, string>) => writeZip(files);

function readEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

/**
 * The consistency check (OPS-014 (1)): the manifest is whole and both kits carry it; the
 * backend's address, instance and key are the manifest's; the frontend talks to that backend
 * from an allowed origin; and no secret of this build appears anywhere in the frontend kit.
 * Answers the problems found, none when the kits agree.
 */
export async function checkKits(
  kits: Kits,
  secrets?: GeneratedSecrets,
  user: UserSecrets = {},
): Promise<string[]> {
  const problems: string[] = [];
  const m = kits.manifest.manifest;
  if (!(await verifyManifest(kits.manifest))) problems.push('the manifest signature does not hold');
  const text = json(kits.manifest);
  if (kits.backend[MANIFEST_FILE] !== text)
    problems.push('the backend kit carries another manifest');
  if (kits.frontend[MANIFEST_FILE] !== text)
    problems.push('the frontend kit carries another manifest');
  const env = readEnv(kits.backend[ENV_FILE] ?? '');
  if (env.PUBLIC_URL !== m.apiUrl) problems.push('the backend address differs from the manifest');
  if (env.TASKMOOR_INSTANCE_ID !== m.instanceId) problems.push('the instance id differs');
  const key = env.TASKMOOR_INSTANCE_KEY;
  if (!key || (await instancePublicKey(key)).fingerprint !== m.keyFingerprint) {
    problems.push('the instance key does not match the manifest’s fingerprint');
  }
  const allowed = (env.TASKMOOR_ALLOWED_ORIGINS ?? '').split(',');
  for (const origin of m.frontendOrigins) {
    if (!allowed.includes(origin)) problems.push(`the backend does not allow ${origin}`);
  }
  const config = JSON.parse(kits.frontend[CONFIG_FILE] ?? '{}') as RuntimeConfig;
  const target = config.apiUrl === '' ? m.frontendOrigins[0] : config.apiUrl;
  if (target !== m.apiUrl) problems.push('the frontend talks to another backend');
  if (config.routing !== m.routing || config.basePath !== m.basePath) {
    problems.push('the frontend routing differs from the manifest');
  }
  if (config.instanceId !== m.instanceId || config.instanceKey !== m.publicKey) {
    problems.push('the frontend is pinned to another instance');
  }
  const secret = [
    ...(secrets ? secretValues(secrets) : [key ?? '']),
    ...[user.smtpPassword, user.aiKey].filter((s): s is string => Boolean(s)),
  ].filter(Boolean);
  for (const [path, content] of Object.entries(kits.frontend)) {
    if (secret.some((s) => content.includes(s))) problems.push(`a secret is in ${path}`);
  }
  return problems;
}

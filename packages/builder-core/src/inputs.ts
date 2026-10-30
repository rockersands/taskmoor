import { z } from 'zod';

/**
 * The Builder's form (M1-109; OPS-014, spec 05b section 1.2). Everything here is public and
 * may be saved in a project file as it is; the secrets a person types (the SMTP password, an AI
 * provider's key) travel separately as `UserSecrets`. Validation answers with codes per field,
 * and English messages for the CLI; the web Builder shows its own text for each code.
 */
export const LANGUAGES = ['en', 'es'] as const;
export const AI_PROVIDERS = [
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
  'openai-compatible',
] as const;

export const builderInputs = z.object({
  /** Where the backend answers, such as https://api.example.com. */
  backendUrl: z.string(),
  /** Where the frontend kit is served, such as https://tracker.example.com/ or /tracker/. */
  frontendUrl: z.string(),
  instanceName: z.string().trim().max(100).default(''),
  defaultLanguage: z.enum(LANGUAGES).default('en'),
  /** Clean URLs by default in the kits (M1-134, ADR-066); hash routing for hosts without rewrites. */
  routing: z.enum(['path', 'hash']).default('path'),
  branding: z
    .object({
      accentColour: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    })
    .default({}),
  smtp: z
    .object({
      host: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65_535),
      user: z.string().max(255).default(''),
      from: z.string().max(320).default(''),
    })
    .optional(),
  ai: z.object({ provider: z.enum(AI_PROVIDERS) }).optional(),
  target: z.enum(['compose', 'helm']).default('compose'),
  /**
   * How the frontend signs in (M1-107, ADR-080): `auto` picks the backend's cookie when both
   * addresses are one site and OAuth otherwise; `session` or `oauth` overrides that.
   */
  signIn: z.enum(['auto', 'session', 'oauth']).default('auto'),
});

export type BuilderInputs = z.output<typeof builderInputs>;

/** What a person types that must stay secret: never in a project file unless encrypted. */
export interface UserSecrets {
  smtpPassword?: string;
  aiKey?: string;
}

export type InputCode =
  | 'invalid'
  | 'not_a_url'
  | 'insecure_url'
  | 'has_path'
  | 'has_query'
  | 'not_a_directory';

export interface InputProblem {
  field: string;
  code: InputCode;
  message: string;
}

const MESSAGES: Record<InputCode, string> = {
  invalid: 'This value is not valid.',
  not_a_url: 'Enter a full address such as https://tracker.example.com.',
  insecure_url:
    'Use https: plain http is only for a machine of your own (localhost or a .test name).',
  has_path: 'The backend address takes no path: the API lives at its root.',
  has_query: 'The address takes no query or fragment.',
  not_a_directory: 'End the address with a slash: it names the folder the app is served from.',
};

/** Hosts that never leave a machine or a test network, where plain http is acceptable. */
function isLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}

function checkUrl(field: string, raw: string, kind: 'backend' | 'frontend'): InputProblem[] {
  const problem = (code: InputCode) => [{ field, code, message: MESSAGES[code] }];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return problem('not_a_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return problem('not_a_url');
  if (url.protocol === 'http:' && !isLocal(url.hostname)) return problem('insecure_url');
  if (url.search || url.hash || raw.includes('#')) return problem('has_query');
  if (url.username || url.password) return problem('not_a_url');
  if (kind === 'backend' && url.pathname !== '/') return problem('has_path');
  if (kind === 'frontend' && !url.pathname.endsWith('/')) return problem('not_a_directory');
  return [];
}

export type Validated =
  | { ok: true; inputs: BuilderInputs }
  | { ok: false; problems: InputProblem[] };

export function validateInputs(raw: unknown): Validated {
  const parsed = builderInputs.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'form',
        code: 'invalid' as const,
        message: MESSAGES.invalid,
      })),
    };
  }
  const problems = [
    ...checkUrl('backendUrl', parsed.data.backendUrl, 'backend'),
    ...checkUrl('frontendUrl', parsed.data.frontendUrl, 'frontend'),
  ];
  return problems.length > 0 ? { ok: false, problems } : { ok: true, inputs: parsed.data };
}

/** The backend's origin, without a trailing slash: https://api.example.com. */
export const apiOrigin = (inputs: BuilderInputs) => new URL(inputs.backendUrl).origin;
/** The frontend's origin, the one CORS and WebSocket checks allow. */
export const frontendOrigin = (inputs: BuilderInputs) => new URL(inputs.frontendUrl).origin;
/** Where on its host the app sits: `/` or `/tracker/`. */
export const basePath = (inputs: BuilderInputs) => new URL(inputs.frontendUrl).pathname;

const IP = /^(\d{1,3}\.){3}\d{1,3}$|^\[/;
/** Two-letter country suffixes under a short label, which nobody registers below: co.uk, com.au. */
const SHORT_SUFFIX = /^[a-z]{2,3}\.[a-z]{2}$/;

/**
 * Whether two hosts are one site for the browser's cookie rules (M1-107): the same host, one
 * inside the other, or siblings under a parent of at least two labels that is not a country
 * suffix such as co.uk. Without the public suffix list this is careful, so when in doubt it
 * says no: OAuth then signs the frontend in, which works across any two sites.
 */
export function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  if (IP.test(a) || IP.test(b)) return false;
  const site = (parent: string) => parent.split('.').length >= 2 && !SHORT_SUFFIX.test(parent);
  if (a.endsWith(`.${b}`)) return site(b);
  if (b.endsWith(`.${a}`)) return site(a);
  const parent = (host: string) => host.slice(host.indexOf('.') + 1);
  return a.includes('.') && parent(a) === parent(b) && site(parent(a));
}

/** How the frontend kit signs in: the backend's cookie on one site, OAuth across sites. */
export function signInMode(inputs: BuilderInputs): 'session' | 'oauth' {
  if (inputs.signIn !== 'auto') return inputs.signIn;
  const api = new URL(inputs.backendUrl);
  const app = new URL(inputs.frontendUrl);
  return api.protocol === app.protocol && sameSite(api.hostname, app.hostname)
    ? 'session'
    : 'oauth';
}

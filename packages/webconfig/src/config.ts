/**
 * The public runtime configuration of the static frontend (M1-105, ADR-065). It lives in a slot
 * in the built index.html, a JSON data block the page reads before anything else runs, and is
 * filled where the frontend is deployed without rebuilding it: by the backend when it serves the
 * frontend itself, by the Builder's frontend kit (M1-111), or by hand on a static host.
 *
 * Only public settings fit in it. Every key is listed here; an unknown key is refused when
 * filling and ignored when reading, so a secret cannot ride along under a new name.
 */

/** How the app writes its addresses: `#/boards/7` works on any host; `/boards/7` needs a fallback. */
export type RoutingMode = 'hash' | 'path';

export const ROUTING_MODES: readonly RoutingMode[] = ['hash', 'path'];

export interface RuntimeConfig {
  /** The backend's public URL, such as `https://api.example.com`; empty for the page's own origin. */
  apiUrl: string;
  /** Hash routing (the default) or clean URLs. */
  routing: RoutingMode;
  /** Where the app sits on its host, `/` or `/tracker/`; clean URLs are written below it. */
  basePath: string;
  /** The instance's name, shown in the page title; empty for the product name alone. */
  instanceName: string;
}

export const DEFAULT_RUNTIME_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  apiUrl: '',
  routing: 'hash',
  basePath: '/',
  instanceName: '',
});

export const RUNTIME_CONFIG_KEYS = Object.keys(DEFAULT_RUNTIME_CONFIG) as (keyof RuntimeConfig)[];

/** The id of the slot: `<script id="taskmoor-config" type="application/json">{}</script>`. */
export const CONFIG_ELEMENT_ID = 'taskmoor-config';

/** The longest instance name, as first-run setup allows it. */
export const INSTANCE_NAME_MAX = 100;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Path characters that need no escaping in an attribute or a URL: no quotes, angle brackets or spaces. */
const BASE_PATH = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/)*$/;

export class RuntimeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid frontend configuration: ${problems.join('; ')}`);
    this.name = 'RuntimeConfigError';
  }
}

/** The backend URL without a trailing slash, or a problem. Plain http only for this machine (ADR-032). */
function checkApiUrl(value: unknown): string | { problem: string } {
  if (typeof value !== 'string') return { problem: 'apiUrl must be text' };
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: `apiUrl is not a URL: ${value}` };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    return { problem: 'apiUrl must use https (plain http only for localhost)' };
  }
  if (url.username || url.password) return { problem: 'apiUrl must not carry a user or password' };
  if (url.search || url.hash) return { problem: 'apiUrl must not have a query or a fragment' };
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function checkBasePath(value: unknown): string | { problem: string } {
  if (typeof value !== 'string') return { problem: 'basePath must be text' };
  const segments = value.split('/');
  if (!BASE_PATH.test(value) || segments.includes('.') || segments.includes('..')) {
    return { problem: `basePath must look like / or /tracker/: ${value}` };
  }
  return value;
}

/**
 * Reads a configuration: every known key that is valid, the default for the rest, and the
 * problems found (unknown keys, invalid values). Never throws, so a mistyped value on a static
 * host leaves the app running on its defaults.
 */
export function parseRuntimeConfig(raw: unknown): { config: RuntimeConfig; problems: string[] } {
  const config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
  const problems: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, problems: ['the configuration must be a JSON object'] };
  }
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'apiUrl': {
        const checked = checkApiUrl(value);
        if (typeof checked === 'string') config.apiUrl = checked;
        else problems.push(checked.problem);
        break;
      }
      case 'routing':
        if ((ROUTING_MODES as readonly unknown[]).includes(value)) {
          config.routing = value as RoutingMode;
        } else {
          problems.push(`routing must be ${ROUTING_MODES.join(' or ')}`);
        }
        break;
      case 'basePath': {
        const checked = checkBasePath(value);
        if (typeof checked === 'string') config.basePath = checked;
        else problems.push(checked.problem);
        break;
      }
      case 'instanceName':
        if (typeof value === 'string' && value.trim().length <= INSTANCE_NAME_MAX) {
          config.instanceName = value.trim();
        } else {
          problems.push(`instanceName must be text of at most ${INSTANCE_NAME_MAX} characters`);
        }
        break;
      default:
        problems.push(`unknown setting ${JSON.stringify(key)}`);
    }
  }
  return { config, problems };
}

/** The slot's text as JSON, read as `parseRuntimeConfig` reads it; empty text is the defaults. */
export function parseSlotText(text: string): { config: RuntimeConfig; problems: string[] } {
  if (text.trim() === '') return parseRuntimeConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: { ...DEFAULT_RUNTIME_CONFIG }, problems: ['the configuration is not JSON'] };
  }
  return parseRuntimeConfig(raw);
}

const SLOT = new RegExp(
  `(<script\\b[^>]*\\bid="${CONFIG_ELEMENT_ID}"[^>]*>)([\\s\\S]*?)(</script>)`,
  'i',
);
const BASE_ELEMENT = /<base\b[^>]*>[ \t]*\r?\n?[ \t]*/gi;

/** The configuration in a built index.html, or null when the page has no slot. */
export function readRuntimeConfig(
  html: string,
): { config: RuntimeConfig; problems: string[] } | null {
  const match = SLOT.exec(html);
  return match ? parseSlotText(match[2] ?? '') : null;
}

/**
 * Writes a configuration into a built index.html: the slot's JSON (every key, defaults
 * included) and, for clean URLs, a `<base href>` before it so the page's relative asset URLs
 * resolve from the base path at any depth. Throws on an invalid configuration or a page
 * without a slot.
 */
export function fillRuntimeConfig(html: string, settings: Partial<RuntimeConfig>): string {
  const { config, problems } = parseRuntimeConfig(settings);
  if (problems.length > 0) throw new RuntimeConfigError(problems);
  if (!SLOT.test(html)) throw new RuntimeConfigError(['index.html has no configuration slot']);
  // `<` escaped, so nothing in a value can close the script element.
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');
  const base = config.routing === 'path' ? `<base href="${config.basePath}" />\n    ` : '';
  return html
    .replace(BASE_ELEMENT, '')
    .replace(SLOT, (_whole, open: string, _old: string, close: string) => {
      return `${base}${open}${json}${close}`;
    });
}

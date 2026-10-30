/**
 * The app's content security policy (M1-107; IAM-025, ADR-080), one text for every way the
 * frontend is served: the backend's header, the frontend kit's meta element, the e2e preview.
 *
 * Scripts and stylesheets come only from the app's own origin (or, in the single-file kit,
 * from the inline blocks whose hashes are listed); nothing is evaluated from text. Style
 * attributes stay allowed: the editor's carets and charts set them, and they cannot run code.
 * The backend, when it is another origin, may be called, opened as a WebSocket, and serve
 * images, media and the attachment preview frame, as may the origins attachments are
 * downloaded from (an S3 bucket's signed URLs). Plugins, `<base>` elsewhere and form posts to
 * other origins are refused. A header also refuses framing by any page, which a meta element
 * cannot say.
 */
export interface CspOptions {
  /** The backend's URL when it is another origin than the page's (the runtime `apiUrl`). */
  apiUrl?: string;
  /** Further origins attachments come from, such as a bucket's public endpoint. */
  mediaOrigins?: readonly string[];
  /** `'sha256-…'` sources of inline scripts and style elements (the single-file kit). */
  scriptHashes?: readonly string[];
  styleHashes?: readonly string[];
  /** For a response header: adds `frame-ancestors 'none'`, which meta elements ignore. */
  header?: boolean;
}

/** `https://api.example.com` and its WebSocket twin, `wss://api.example.com`. */
function backendSources(apiUrl: string | undefined): { http: string[]; ws: string[] } {
  if (!apiUrl) return { http: [], ws: [] };
  const origin = new URL(apiUrl).origin;
  return { http: [origin], ws: [origin.replace(/^http/, 'ws')] };
}

export function contentSecurityPolicy(options: CspOptions = {}): string {
  const api = backendSources(options.apiUrl);
  const media = [...new Set([...api.http, ...(options.mediaOrigins ?? [])])];
  const scripts = options.scriptHashes ?? [];
  const styles = options.styleHashes ?? [];
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    ['script-src', "'self'", ...scripts],
    ['style-src', "'self'", ...styles],
    ['style-src-elem', "'self'", ...styles],
    ['style-src-attr', "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:', ...media],
    ['media-src', "'self'", 'blob:', ...media],
    ['frame-src', "'self'", 'blob:', ...media],
    ['font-src', "'self'", 'data:'],
    ['connect-src', "'self'", ...api.http, ...api.ws],
    ['worker-src', "'self'", 'blob:'],
    ['manifest-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
  ];
  if (options.header) directives.push(['frame-ancestors', "'none'"]);
  return directives.map((d) => d.join(' ')).join('; ');
}

/** The meta element carrying a policy, for a page served without the header. */
export function cspMetaElement(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}" />`;
}

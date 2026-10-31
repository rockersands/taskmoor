import { ApiError, api } from '../api/client';

/**
 * The consent page's backend (M1-072; API-002 (3); ADR-084): the authorization request an MCP
 * client made, and the person's answer. The answer comes back as the address to send the
 * browser to: the client's redirect with a code, or with `access_denied`.
 */
export interface ConsentRequest {
  client: { id: string; name: string; clientUri: string | null; registeredAt: string };
  redirectUri: string;
  /** What the client asked for. */
  scope: 'read' | 'read write';
}

export type ConsentFailure = 'signed-out' | 'gone' | 'failed';

export interface ConsentClient {
  load(id: string): Promise<ConsentRequest>;
  answer(id: string, approve: boolean, scope: 'read' | 'read write'): Promise<string>;
  /** Leaves the page for the client's redirect. */
  go(url: string): void;
}

/** What went wrong, in the page's terms. */
export function consentFailure(error: unknown): ConsentFailure {
  if (error instanceof ApiError && error.status === 401) return 'signed-out';
  if (error instanceof ApiError && error.status === 404) return 'gone';
  return 'failed';
}

export const consentClient: ConsentClient = {
  load: async (id) =>
    (await api<{ request: ConsentRequest }>(`/oauth/requests/${encodeURIComponent(id)}`)).request,
  answer: async (id, approve, scope) =>
    (
      await api<{ redirect: string }>(`/oauth/requests/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: { approve, scope },
      })
    ).redirect,
  go: (url) => window.location.assign(url),
};

/** Where the client sends the person back, in words a person can check. */
export function redirectPlace(
  uri: string,
): { kind: 'site'; host: string } | { kind: 'this-computer' } | { kind: 'app'; scheme: string } {
  try {
    const url = new URL(uri);
    if (url.protocol === 'https:') return { kind: 'site', host: url.host };
    if (url.protocol === 'http:') return { kind: 'this-computer' };
    return { kind: 'app', scheme: url.protocol.replace(/:$/, '') };
  } catch {
    return { kind: 'app', scheme: uri };
  }
}

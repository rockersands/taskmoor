import type { FrontendWindow } from '@taskmoor/webconfig';
import { runtimeConfig } from '../runtime/config';
import { WEB_VERSION } from '../runtime/version';

/** The parts of the backend's meta answer (GET /api/meta, M1-106) the app reads. */
export interface Meta {
  version: string;
  frontend: FrontendWindow;
  instance: { id: string; name: string; publicKey: string };
  /** The instance's signature over the nonce asked for (M1-111), when one was. */
  signature?: { nonce: string; value: string };
}

export interface MetaClient {
  /** With a nonce, the instance signs it, so a pinned frontend can check who answered. */
  meta(nonce?: string): Promise<Meta>;
}

/**
 * The meta endpoint sits beside the versioned API, at the backend's own address. A frontend on
 * another origin says which version it runs, so the backend's list of registered frontends
 * shows it (M1-108); the backend's own pages need not, it serves them.
 */
export function metaQuery(nonce: string | undefined, apiUrl = runtimeConfig.apiUrl): string {
  const params = new URLSearchParams();
  if (nonce) params.set('nonce', nonce);
  if (apiUrl) params.set('frontend', WEB_VERSION);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const httpMetaClient: MetaClient = {
  async meta(nonce) {
    const query = metaQuery(nonce);
    const response = await fetch(`${runtimeConfig.apiUrl}/api/meta${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`meta ${response.status}`);
    const body = (await response.json()) as Partial<Meta> | null;
    // Something else answering at that address (a proxy's page, an older backend) is no answer.
    const frontend = body?.frontend;
    if (typeof body?.version !== 'string' || typeof frontend !== 'object' || frontend === null) {
      throw new Error('not a meta answer');
    }
    return body as Meta;
  },
};

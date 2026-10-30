import type { FrontendWindow } from '@taskmoor/webconfig';
import { runtimeConfig } from '../runtime/config';

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

/** The meta endpoint sits beside the versioned API, at the backend's own address. */
export const httpMetaClient: MetaClient = {
  async meta(nonce) {
    const query = nonce ? `?nonce=${encodeURIComponent(nonce)}` : '';
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

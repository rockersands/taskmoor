import type { FrontendWindow } from '@taskmoor/webconfig';
import { runtimeConfig } from '../runtime/config';

/** The parts of the backend's meta answer (GET /api/meta, M1-106) the app reads. */
export interface Meta {
  version: string;
  frontend: FrontendWindow;
  instance: { id: string; name: string };
}

export interface MetaClient {
  meta(): Promise<Meta>;
}

/** The meta endpoint sits beside the versioned API, at the backend's own address. */
export const httpMetaClient: MetaClient = {
  async meta() {
    const response = await fetch(`${runtimeConfig.apiUrl}/api/meta`, { cache: 'no-store' });
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

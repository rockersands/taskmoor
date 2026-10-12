import { createServer } from 'node:net';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Server } from '@hocuspocus/server';
import { canonicalAdf, fromAdfJson, type PmJson, schema, toAdfFromJson } from '@taskmoor/richtext';
import { generateAdfDocuments } from '@taskmoor/richtext/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

/**
 * ADR-014 spike, part 2: documents survive the collaboration layer. Part 1 (format round
 * trip) lives in @taskmoor/richtext.
 */

const FRAGMENT = 'prosemirror';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for sync');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Yjs round trip', () => {
  it('keeps 50 documents intact through a Y.Doc and an encoded update', () => {
    const t0 = Date.now();
    for (const doc of generateAdfDocuments(50, 7)) {
      const ydoc = new Y.Doc();
      prosemirrorJSONToYXmlFragment(schema, fromAdfJson(doc), ydoc.getXmlFragment(FRAGMENT));
      // Another peer receiving the full state as one update.
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
      const back = yXmlFragmentToProsemirrorJSON(copy.getXmlFragment(FRAGMENT)) as PmJson;
      expect(canonicalAdf(toAdfFromJson(back))).toEqual(canonicalAdf(doc));
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe('Hocuspocus sync', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    server = new Server({ port });
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
  });

  it('carries a document from one client to another and back out of the format', async () => {
    const [doc] = generateAdfDocuments(1, 99);
    if (!doc) throw new Error('no document');

    const connect = (document: Y.Doc) => {
      const websocketProvider = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}`,
        WebSocketPolyfill: WebSocket,
      });
      const provider = new HocuspocusProvider({ websocketProvider, name: 'doc-1', document });
      provider.attach(); // v4 providers connect only once attached
      return { websocketProvider, provider };
    };
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = connect(docA);
    const b = connect(docB);
    try {
      await waitFor(() => a.provider.isSynced && b.provider.isSynced);
      const t0 = Date.now();
      prosemirrorJSONToYXmlFragment(schema, fromAdfJson(doc), docA.getXmlFragment(FRAGMENT));
      const expected = JSON.stringify(yXmlFragmentToProsemirrorJSON(docA.getXmlFragment(FRAGMENT)));
      await waitFor(
        () =>
          JSON.stringify(yXmlFragmentToProsemirrorJSON(docB.getXmlFragment(FRAGMENT))) === expected,
      );
      const syncMs = Date.now() - t0;
      expect(syncMs).toBeLessThan(5_000);

      const back = yXmlFragmentToProsemirrorJSON(docB.getXmlFragment(FRAGMENT)) as PmJson;
      expect(canonicalAdf(toAdfFromJson(back))).toEqual(canonicalAdf(doc));
    } finally {
      a.provider.destroy();
      b.provider.destroy();
      a.websocketProvider.destroy();
      b.websocketProvider.destroy();
    }
  }, 30_000);
});

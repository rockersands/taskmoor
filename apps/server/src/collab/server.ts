import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type Connection, type Document, Hocuspocus } from '@hocuspocus/server';
import type { Database, RichTextField } from '@taskmoor/db';
import { docFromYDoc, writeDocToYDoc } from '@taskmoor/richtext';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { resolveSession, SECURE_SESSION_COOKIE, SESSION_COOKIE } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import type { FieldCatalogs } from '../fields/catalog';
import { checkRichText } from '../tickets/model';
import { docHash } from '../tickets/rich-text';
import { loadTicket } from '../tickets/store';
import { defaultWorkspaceId } from '../workspace';
import { loadState, mayEditText, writeCollaborativeText } from './persist';

/**
 * Real-time co-editing of rich text (M1-017; NTF-008; ADR-014 "Implementation (M1-017)").
 *
 * - Clients connect a WebSocket to `/api/v1/collab` (the realtime role, on the HTTP server
 *   of the process) and open documents named `ticket/<id>/<field>` over the Hocuspocus
 *   protocol: one Yjs document per rich text field.
 * - The upgrade needs a signed-in session (the cookie) and, when the browser names an origin,
 *   this instance's own origin (cross-site WebSocket hijacking, ADR-032). Each document then
 *   needs what an edit of the field through the API needs: the person sees the ticket (track
 *   browsing and its visibility level, M1-020), holds "Edit tickets" there, and the edit form
 *   shows the field. People who may only read it are refused and read it through the API.
 * - A document loads from the ticket's text, or from its stored Yjs state while that still
 *   holds the same text. Changes are saved two seconds after typing pauses (ten at most), and
 *   when the last person leaves: to the ticket like an edit through the API (history, version,
 *   one `ticket.updated` event naming the last editor) and to `ticket_text_state`.
 * - After any change through the API, open documents are checked again: a ticket written
 *   another way shows its new text to everyone in it, and people who lost access are let go.
 *   Without such a change the check runs every 30 seconds.
 * - One process holds a document: with several realtime processes, route `/api/v1/collab` by
 *   document (sticky sessions) until the processes relay updates to each other.
 */
export const COLLAB_PATH = '/api/v1/collab';

/** The biggest message a client may send: a whole document's state with room to spare. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const RECHECK_EVERY_MS = 30_000;
const RECHECK_AFTER_WRITE_MS = 50;

export interface CollabContext {
  workspaceId: number;
  userId: number;
}

interface OpenDocument {
  ticketId: number;
  field: RichTextField;
  workspaceId: number;
  /** Hash of the ticket's text as this process last read or wrote it. */
  base: string;
  /** Who made the latest change not yet saved. */
  editor: number | null;
}

const DOCUMENT_NAME = /^ticket\/([1-9][0-9]{0,9})\/(description|environment)$/;

export function documentName(ticketId: number, field: RichTextField): string {
  return `ticket/${ticketId}/${field}`;
}

/**
 * Why a document was refused; Hocuspocus sends the reason to the client. No message: the
 * library logs every hook error that has one, and a refusal is no error.
 */
class Refusal extends Error {
  constructor(readonly reason: 'not-found' | 'forbidden') {
    super();
  }
}

/** Changes the server makes itself are not saved as anyone's edit. */
const SERVER_ORIGIN = { source: 'local', skipStoreHooks: true } as const;

export interface CollaborationOptions {
  db: Kysely<Database>;
  authorizer: Authorizer;
  catalogs: FieldCatalogs;
  /** Where browsers reach this instance; its origin may open sockets. */
  publicUrl: string;
  /** Milliseconds of quiet before a save (tests shorten it). */
  debounceMs?: number;
}

export class Collaboration {
  readonly hocuspocus: Hocuspocus<CollabContext>;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly open = new Map<string, OpenDocument>();
  private readonly publicOrigin: string | null;
  private recheckTimer: NodeJS.Timeout | undefined;
  private everyTimer: NodeJS.Timeout | undefined;
  private recheckRunning: Promise<void> | null = null;
  private log: FastifyInstance['log'] | undefined;

  constructor(private readonly options: CollaborationOptions) {
    try {
      this.publicOrigin = new URL(options.publicUrl).origin;
    } catch {
      this.publicOrigin = null;
    }
    this.hocuspocus = new Hocuspocus<CollabContext>({
      quiet: true,
      debounce: options.debounceMs ?? 2_000,
      maxDebounce: Math.max(10_000, options.debounceMs ?? 0),
      onAuthenticate: async ({ documentName: name, context }) => {
        const doc = parseName(name);
        if (!doc) throw new Refusal('not-found');
        await this.admit(context, doc.ticketId, doc.field);
      },
      onLoadDocument: async ({ documentName: name, document, context }) => {
        const doc = parseName(name) as { ticketId: number; field: RichTextField };
        const row = await loadTicket(options.db, context.workspaceId, doc.ticketId);
        if (!row) throw new Refusal('not-found');
        const text = row[doc.field];
        const state = await loadState(options.db, doc.ticketId, doc.field, text);
        if (state) Y.applyUpdate(document, state);
        else writeDocToYDoc(document, text as never);
        this.open.set(name, {
          ticketId: doc.ticketId,
          field: doc.field,
          workspaceId: context.workspaceId,
          base: docHash(text),
          editor: null,
        });
      },
      onChange: async ({ documentName: name, context, connection }) => {
        const open = this.open.get(name);
        if (open && connection) open.editor = context.userId;
      },
      onStoreDocument: async ({ documentName: name, document }) => {
        try {
          await this.store(name, document);
        } catch (error) {
          this.log?.error({ error, document: name }, 'collaborative text not saved');
        }
      },
      afterUnloadDocument: async ({ documentName: name }) => {
        this.open.delete(name);
      },
    });
  }

  /** Serves `/api/v1/collab` on the app's HTTP server and keeps open documents in step. */
  /** Takes the upgrades to /api/v1/collab; `others` gets the rest (404 without one). */
  attach(
    app: FastifyInstance,
    others?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void {
    this.log = app.log;
    app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (request.url ?? '').split('?')[0];
      if (path !== COLLAB_PATH) {
        if (others) others(request, socket, head);
        else reject(socket, 404);
        return;
      }
      this.upgrade(app, request, socket, head).catch((error) => {
        app.log.warn({ error }, 'collaboration upgrade failed');
        reject(socket, 500);
      });
    });
    // A change through the API may have written a ticket's text or someone's access to it.
    app.addHook('onResponse', async (request, reply) => {
      if (this.open.size === 0) return;
      if (request.method === 'GET' || request.method === 'HEAD') return;
      if (reply.statusCode >= 400 || !request.url.startsWith('/api/')) return;
      this.scheduleRecheck(RECHECK_AFTER_WRITE_MS);
    });
    app.addHook('onReady', async () => {
      this.everyTimer = setInterval(() => {
        if (this.open.size > 0) this.scheduleRecheck(0);
      }, RECHECK_EVERY_MS);
      this.everyTimer.unref();
    });
    app.addHook('onClose', async () => {
      await this.close();
    });
  }

  /** Saves what is pending and lets everyone go. */
  async close(): Promise<void> {
    clearInterval(this.everyTimer);
    clearTimeout(this.recheckTimer);
    await this.recheckRunning;
    const debouncer = this.hocuspocus.debouncer;
    await Promise.all(
      [...this.hocuspocus.documents.values()].map(async (document) => {
        const id = `onStoreDocument-${document.name}`;
        if (debouncer.isDebounced(id)) await debouncer.executeNow(id);
      }),
    );
    this.hocuspocus.closeConnections();
    for (const socket of this.sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
  }

  /** The documents open in this process, by name (for tests and the status page). */
  openDocuments(): string[] {
    return [...this.open.keys()];
  }

  private async upgrade(
    app: FastifyInstance,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.originAllowed(request)) {
      reject(socket, 403);
      return;
    }
    const db = this.options.db;
    const workspaceId = await defaultWorkspaceId(db);
    const cookies = app.parseCookie(request.headers.cookie ?? '');
    const token = cookies[SECURE_SESSION_COOKIE] ?? cookies[SESSION_COOKIE];
    const session = await resolveSession(db, workspaceId, token);
    if (!session) {
      reject(socket, 401);
      return;
    }
    const context: CollabContext = { workspaceId, userId: session.user.id };
    // What the hooks see of the request: no cookie or credentials travel further.
    const headers = new Headers();
    for (const name of ['user-agent', 'origin', 'host']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const seen = { headers, url: `http://${request.headers.host ?? 'localhost'}${request.url}` };
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      const connection = this.hocuspocus.handleConnection(ws, seen as Request, context);
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        connection.handleMessage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      });
      ws.on('close', (code: number, reason: Buffer) => {
        connection.handleClose({ code, reason: reason.toString() });
      });
      ws.on('error', (error) => app.log.debug({ error }, 'collaboration socket error'));
    });
  }

  /** A browser may connect only from this instance's own origin (or its public URL's). */
  private originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    return url.origin === this.publicOrigin || url.host === request.headers.host;
  }

  private async admit(context: CollabContext, ticketId: number, field: RichTextField) {
    const { db, authorizer, catalogs } = this.options;
    const row = await loadTicket(db, context.workspaceId, ticketId);
    if (!row) throw new Refusal('not-found');
    const allowed = await mayEditText(
      authorizer,
      catalogs,
      context.workspaceId,
      context.userId,
      row,
      field,
    );
    if (allowed === 'missing') throw new Refusal('not-found');
    if (allowed === 'refused') throw new Refusal('forbidden');
  }

  private async store(name: string, document: Document): Promise<void> {
    const open = this.open.get(name);
    if (!open) return;
    const checked = checkRichText(docFromYDoc(document));
    const actorId = open.editor;
    if (!checked.ok || actorId === null) {
      // Too long for a ticket, or nobody's change: the ticket's text stands.
      if (!checked.ok) await this.reload(name, document, open);
      return;
    }
    const outcome = await writeCollaborativeText(
      this.options.db,
      this.options.authorizer,
      this.options.catalogs,
      {
        workspaceId: open.workspaceId,
        ticketId: open.ticketId,
        field: open.field,
        doc: checked.doc,
        actorId,
        ip: null,
        state: Y.encodeStateAsUpdate(document),
      },
    );
    if (outcome.status === 'written' || outcome.status === 'unchanged') {
      if (open.editor === actorId) open.editor = null;
      open.base = docHash(checked.doc);
      return;
    }
    // Refused or gone: the ticket's text stands, and whoever may no longer edit leaves.
    await this.reload(name, document, open);
    await this.letGo(name, document, open);
  }

  /** Puts the ticket's current text into an open document. */
  private async reload(name: string, document: Document, open: OpenDocument): Promise<void> {
    const row = await loadTicket(this.options.db, open.workspaceId, open.ticketId);
    if (!row || row.deleted_at) {
      this.hocuspocus.closeConnections(name);
      return;
    }
    const text = row[open.field];
    open.base = docHash(text);
    open.editor = null;
    writeDocToYDoc(document, text as never, SERVER_ORIGIN);
  }

  /** Closes the connections of people who may no longer edit the document. */
  private async letGo(name: string, document: Document, open: OpenDocument): Promise<void> {
    const { db, authorizer, catalogs } = this.options;
    const row = await loadTicket(db, open.workspaceId, open.ticketId);
    const verdicts = new Map<number, string>();
    for (const connection of document.getConnections() as Connection<CollabContext>[]) {
      const userId = connection.context.userId;
      let verdict = verdicts.get(userId);
      if (verdict === undefined) {
        verdict = row
          ? await mayEditText(authorizer, catalogs, open.workspaceId, userId, row, open.field)
          : 'missing';
        verdicts.set(userId, verdict);
      }
      if (verdict !== 'yes') connection.close({ code: 4403, reason: 'forbidden' });
    }
    if (!row || row.deleted_at) this.hocuspocus.closeConnections(name);
  }

  private scheduleRecheck(delayMs: number): void {
    if (this.recheckTimer) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      const previous = this.recheckRunning ?? Promise.resolve();
      this.recheckRunning = previous
        .then(() => this.recheck())
        .catch((error) => this.log?.warn({ error }, 'collaboration recheck failed'))
        .finally(() => {
          this.recheckRunning = null;
        });
    }, delayMs);
    this.recheckTimer.unref();
  }

  /** Brings every open document in step with its ticket and its people's access. */
  async recheck(): Promise<void> {
    for (const [name, open] of [...this.open]) {
      const document = this.hocuspocus.documents.get(name);
      if (!document) continue;
      const row = await loadTicket(this.options.db, open.workspaceId, open.ticketId);
      if (!row || row.deleted_at) {
        this.hocuspocus.closeConnections(name);
        continue;
      }
      // Written another way since this process last read or saved it: everyone sees the new
      // text (the last write wins; what it replaced is in the history).
      if (docHash(row[open.field]) !== open.base) await this.reload(name, document, open);
      await this.letGo(name, document, open);
    }
  }
}

function parseName(name: string): { ticketId: number; field: RichTextField } | null {
  const match = DOCUMENT_NAME.exec(name);
  return match ? { ticketId: Number(match[1]), field: match[2] as RichTextField } : null;
}

function reject(socket: Duplex, status: 401 | 403 | 404 | 500): void {
  const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Server Error' };
  socket.end(
    `HTTP/1.1 ${status} ${text[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

import { createSocket } from 'node:dgram';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import { type AuditView, exportAudit } from './query';

/**
 * Audit records forwarded to syslog (M1-085; IAM-013, the export half of IAM-014; ADR-078).
 * The worker sends what the log gained since the last run, oldest first, as RFC 5424 messages
 * (facility 13, log audit; severity 5, notice) whose text is the record as JSON, the same
 * fields as the JSON export. Over TCP and TLS each message is framed by its length (RFC 6587
 * octet counting); over UDP each is one datagram. The position (`last_seq`) moves only after a
 * batch was handed over, so a receiver that was down gets what it missed. Continuous SIEM
 * streaming with CEF, HTTPS and OpenTelemetry is M2-018.
 */
export interface SyslogTarget {
  host: string;
  port: number;
  transport: 'udp' | 'tcp' | 'tls';
}

const PRI = 13 * 8 + 5;
const BATCH = 500;
const PER_RUN = 5000;

/** A field of the header: printable US-ASCII without spaces, at most `max` long, or `-`. */
function headerField(text: string, max: number): string {
  const clean = text.replace(/[^\x21-\x7e]/g, '').slice(0, max);
  return clean === '' ? '-' : clean;
}

export function syslogMessage(record: AuditView, hostname: string): string {
  return `<${PRI}>1 ${record.occurredAt} ${headerField(hostname, 255)} taskmoor - ${headerField(
    record.action,
    32,
  )} - ${JSON.stringify(record)}`;
}

/** Hands the messages to the receiver; rejects if it cannot within `timeoutMs`. */
export function sendSyslog(
  target: SyslogTarget,
  messages: readonly string[],
  timeoutMs = 10_000,
): Promise<void> {
  if (messages.length === 0) return Promise.resolve();
  if (target.transport === 'udp') {
    return new Promise((resolve, reject) => {
      const socket = createSocket(target.host.includes(':') ? 'udp6' : 'udp4');
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('syslog: timed out'));
      }, timeoutMs);
      let left = messages.length;
      socket.on('error', (error) => {
        clearTimeout(timer);
        socket.close();
        reject(error);
      });
      for (const message of messages) {
        socket.send(message, target.port, target.host, (error) => {
          if (error) return;
          left -= 1;
          if (left === 0) {
            clearTimeout(timer);
            socket.close();
            resolve();
          }
        });
      }
    });
  }
  return new Promise((resolve, reject) => {
    const socket =
      target.transport === 'tls'
        ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
        : tcpConnect({ host: target.host, port: target.port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('syslog: timed out')));
    socket.on('error', reject);
    socket.on('close', (failed) => {
      if (!failed) resolve();
    });
    socket.once(target.transport === 'tls' ? 'secureConnect' : 'connect', () => {
      const frames = messages.map((m) => `${Buffer.byteLength(m)} ${m}`).join('');
      socket.end(frames);
    });
  });
}

export type Sender = (target: SyslogTarget, messages: readonly string[]) => Promise<void>;

/**
 * One forwarding run for a workspace: up to 5,000 records, in batches of 500. Null when no
 * sink is on, or another worker holds it; otherwise how many went and the error, if any.
 */
export async function forwardAudit(
  db: Kysely<Database>,
  workspaceId: number,
  hostname: string,
  send: Sender = sendSyslog,
): Promise<{ sent: number; error: string | null } | null> {
  return db.transaction().execute(async (trx) => {
    const sink = await sql<{
      host: string;
      port: number;
      transport: SyslogTarget['transport'];
      last_seq: string;
    }>`SELECT host, port, transport, last_seq FROM audit_syslog
        WHERE workspace_id = ${workspaceId} AND enabled FOR UPDATE SKIP LOCKED`
      .execute(trx)
      .then((r) => r.rows[0]);
    if (!sink) return null;
    const target = { host: sink.host, port: sink.port, transport: sink.transport };
    let position = Number(sink.last_seq);
    let sent = 0;
    let error: string | null = null;
    let batch: AuditView[] = [];
    const flush = async () => {
      await send(
        target,
        batch.map((r) => syslogMessage(r, hostname)),
      );
      position = batch[batch.length - 1]?.seq ?? position;
      sent += batch.length;
      batch = [];
    };
    try {
      for await (const record of exportAudit(trx as never, workspaceId, {}, BATCH, position)) {
        batch.push(record);
        if (batch.length === BATCH) await flush();
        if (sent + batch.length >= PER_RUN) break;
      }
      if (batch.length > 0) await flush();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await trx
      .updateTable('audit_syslog')
      .set({
        last_seq: position,
        ...(sent > 0 ? { last_sent_at: new Date() } : {}),
        last_error: error,
      })
      .where('workspace_id', '=', workspaceId)
      .execute();
    return { sent, error };
  });
}

/** The newest record's position, where a new sink starts. */
export async function latestSeq(db: Kysely<Database>, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('audit_event')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return Number(row?.seq ?? 0);
}

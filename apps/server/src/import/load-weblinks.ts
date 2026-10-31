import type { JsonValue } from '@taskmoor/db';
import {
  deferChanges,
  existingTarget,
  flushChanges,
  type Loader,
  optional,
  PlanFailure,
  real,
  required,
} from './load';
import type { WebLinkCommand } from './model';

/**
 * Web links (M1-091): a ticket's links to pages outside, as the ticket's web link routes keep
 * them (`routes/links.ts`): an http or https address, a title, a summary, an icon, the
 * relationship's phrase and the linked object's global id. A new one is history too, as a
 * link added in Taskmoor is (`webLink`, by address with the title for display). A re-run
 * updates the link it made.
 */
const MAX = { url: 4000, title: 500, summary: 2000, relationship: 255, globalId: 1000 } as const;

const webLinkPrint = (w: {
  ticket: number | null;
  url: string;
  title: string;
  summary: string;
  relationship: string;
  globalId: string | null;
}): JsonValue => ({ ...w, ticket: real(w.ticket) });

/** Whether an address is one the web link routes accept. */
export function isWebUrl(value: string): boolean {
  if (value.length > MAX.url) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

interface WebLinkData {
  ticket: number;
  creator: number | null;
  iconUrl: string | null;
}

export const webLinks: Loader<WebLinkCommand> = {
  table: { name: 'ticket_web_link', id: 'id' },
  async plan(ctx, cmd, existing) {
    const ticket = required(ctx, cmd.ticket, 'ticket');
    const url = cmd.url.trim();
    const title = cmd.title.trim();
    if (!isWebUrl(url)) throw new PlanFailure('web_link_url_invalid');
    if (title === '' || title.length > MAX.title) throw new PlanFailure('web_link_title_invalid');
    if (cmd.summary.length > MAX.summary || cmd.relationship.length > MAX.relationship) {
      throw new PlanFailure('web_link_too_long');
    }
    if (cmd.globalId !== null && cmd.globalId.length > MAX.globalId) {
      throw new PlanFailure('web_link_too_long');
    }
    let iconUrl = cmd.iconUrl;
    if (iconUrl !== null && !isWebUrl(iconUrl)) {
      ctx.warn({ code: 'web_link_icon_dropped' });
      iconUrl = null;
    }
    const data: WebLinkData = { ticket, creator: optional(ctx, cmd.creator, 'creator'), iconUrl };
    const fingerprint = webLinkPrint({
      ticket,
      url,
      title,
      summary: cmd.summary,
      relationship: cmd.relationship,
      globalId: cmd.globalId,
    });
    if (existing !== null) {
      await existingTarget(ctx, 'ticket_web_link', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as WebLinkData;
    const values = {
      url: cmd.url.trim(),
      title: cmd.title.trim(),
      summary: cmd.summary,
      icon_url: d.iconUrl,
      relationship: cmd.relationship,
      global_id: cmd.globalId,
    };
    if (plan.action === 'update') {
      await ctx.trx
        .updateTable('ticket_web_link')
        .set({ ...values, updated_at: new Date() })
        .where('id', '=', plan.targetId as number)
        .execute();
      return plan.targetId as number;
    }
    const at = cmd.createdAt ?? ctx.now;
    const row = await ctx.trx
      .insertInto('ticket_web_link')
      .values({
        workspace_id: ctx.workspaceId,
        ticket_id: d.ticket,
        ...values,
        created_by: d.creator,
        created_at: at,
        updated_at: at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // A verbatim source's history has the entry for the new link.
    if (!ctx.verbatim) {
      deferChanges(ctx, d.creator, at, [
        {
          ticketId: d.ticket,
          field: 'webLink',
          from: null,
          to: values.url,
          fromDisplay: null,
          toDisplay: values.title,
        },
      ]);
    }
    return row.id;
  },
  async finish(ctx) {
    await flushChanges(ctx);
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('ticket_web_link')
      .select(['id', 'ticket_id', 'url', 'title', 'summary', 'relationship', 'global_id'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(
      rows.map((r) => [
        r.id,
        webLinkPrint({
          ticket: r.ticket_id,
          url: r.url,
          title: r.title,
          summary: r.summary,
          relationship: r.relationship,
          globalId: r.global_id,
        }),
      ]),
    );
  },
};

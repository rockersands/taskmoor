import { placeholder, type SensitiveValue } from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import type { FieldCatalogs } from '../fields/catalog';
import { customKey, ruleOf } from '../fields/layouts';
import { ticketRoutes } from '../routes/tickets';
import { type Caller, callRoute, type TicketRoute } from '../tickets/caller';
import { loadTicket } from '../tickets/store';
import type { AiSettingsCache } from './usage';

/**
 * Tickets as AI features put them in a prompt (M1-077; IAM-022, IAM-023; ADR-100).
 *
 * - The ticket is read through the ticket route as the person asking, so a ticket they cannot
 *   see, or one in the trash they may not restore, is never sent (spec 02c section 1.4, step 2).
 * - Fields an administrator marked sensitive in the AI policy, and fields the ticket's field
 *   rules hide, appear as a placeholder; their values are returned as `sensitive`, for the
 *   gateway to replace wherever a copy of them sits in free text.
 * - The ticket is wrapped as data, so instructions inside it are not taken as the caller's.
 */
export interface TicketContext {
  key: string;
  text: string;
  sensitive: SensitiveValue[];
}

interface TicketView {
  id: number;
  key: string;
  summary: string;
  description: string | null;
  environment: string | null;
  ticketType: { name: string };
  status: { name: string };
  priority: { name: string } | null;
  assignee: { name: string } | null;
  labels: string[];
  fields: Record<string, unknown>;
}

/** A field value as text: strings as they are, lists joined, options and people by name. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const name of ['name', 'value', 'displayName', 'key']) {
      if (typeof v[name] === 'string') {
        const child = v.child ? ` / ${valueText(v.child)}` : '';
        return `${v[name] as string}${child}`;
      }
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/** Texts a value holds, each worth catching on its own in free text. */
function pieces(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(pieces);
  const text = valueText(value).trim();
  return text ? [text] : [];
}

const tag = (text: string) => text.replace(/<\/?ticket[^>]*>/gi, '');

export class AiContext {
  private readonly read: TicketRoute;

  constructor(
    private readonly db: Kysely<Database>,
    authorizer: Authorizer,
    private readonly catalogs: FieldCatalogs,
    private readonly settings: AiSettingsCache,
  ) {
    const route = ticketRoutes(db, authorizer, catalogs).find(
      (r) => r.method === 'GET' && r.url === '/api/v1/tickets/:id',
    );
    if (!route) throw new Error('the ticket read route is missing');
    this.read = route;
  }

  /** The ticket as the caller may see it, ready for a prompt; null when they cannot see it. */
  async ticket(caller: Caller, ticketId: number | string): Promise<TicketContext | null> {
    const answer = await callRoute(this.read, {
      ...caller,
      params: { id: String(ticketId) },
      query: { format: 'text' },
      body: undefined,
    });
    if (answer.statusCode !== 200) return null;
    const view = (answer.payload as { ticket: TicketView }).ticket;
    const row = await loadTicket(this.db, caller.workspaceId, view.id);
    if (!row) return null;
    const [catalog, policy] = await Promise.all([
      this.catalogs.get(caller.workspaceId),
      this.settings.policyOf(caller.workspaceId),
    ]);
    const placement = {
      trackId: row.track_id,
      ticketTypeId: row.ticket_type_id,
      ruleSetId: row.rule_set_id,
      layoutSetId: row.layout_set_id,
    };
    const marked = new Set(policy.redactedFields);
    const sensitive: SensitiveValue[] = [];
    const lines: string[] = [];
    const add = (key: string, label: string, value: unknown) => {
      const text = valueText(value);
      if (!text) return;
      if (marked.has(key) || ruleOf(catalog, placement, key).hidden) {
        for (const piece of pieces(value)) sensitive.push({ value: piece, label });
        lines.push(`${label}: ${placeholder(label)}`);
        return;
      }
      lines.push(text.includes('\n') ? `${label}:\n${text}` : `${label}: ${text}`);
    };
    add('summary', 'Summary', view.summary);
    lines.push(`Type: ${view.ticketType.name}`, `Status: ${view.status.name}`);
    add('priority', 'Priority', view.priority?.name);
    add('assignee', 'Assignee', view.assignee?.name);
    add('labels', 'Labels', view.labels);
    add('description', 'Description', view.description);
    add('environment', 'Environment', view.environment);
    for (const [id, value] of Object.entries(view.fields)) {
      const field = catalog.fields.get(Number(id));
      if (!field) continue;
      add(customKey(field.id), field.name, value);
    }
    return {
      key: view.key,
      sensitive,
      text: `<ticket key="${view.key}">\n${tag(lines.join('\n'))}\n</ticket>`,
    };
  }
}

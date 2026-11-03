import type { HTTPMethods } from 'fastify';
import type { CurrentApiToken, SessionUser } from '../auth';
import type { AuthzContext } from '../authz/authorizer';

/**
 * Who asks for a ticket read or write, as the ticket routes see it: a request, or a background
 * job acting for the person who started it (M1-021). A Fastify request is one; a job builds
 * one from the person, so bulk changes run through exactly the checks a request does.
 */
export interface Caller {
  workspaceId: number;
  user: SessionUser | null;
  authz: AuthzContext;
  /** Set for API-token requests: transitions then run on the REST channel (WF-003). */
  apiToken: CurrentApiToken | null;
  params: unknown;
  query: unknown;
  body: unknown;
  /** Set when a ticket template starts the create (ADR-113): its `ticket.created` names it. */
  ticketTemplateId?: number;
}

/** What a route answers with: a Fastify reply, or a recording of one. */
export interface Answer {
  code(statusCode: number): Answer;
  send(payload?: unknown): Answer;
}

/** An answer kept for the caller to read: a bulk job's per-ticket result. */
export class RecordedAnswer implements Answer {
  statusCode = 200;
  payload: unknown = undefined;
  code(statusCode: number): RecordedAnswer {
    this.statusCode = statusCode;
    return this;
  }
  send(payload?: unknown): RecordedAnswer {
    this.payload = payload;
    return this;
  }
}

export type TicketHandler = (request: Caller, reply: Answer) => Promise<unknown>;

export interface TicketRoute {
  method: HTTPMethods;
  url: string;
  handler: TicketHandler;
}

/**
 * Runs a route's handler for a caller and records the answer: what it sent, or what it
 * returned (a handler may return its body instead of sending it).
 */
export async function callRoute(
  route: TicketRoute,
  caller: Caller,
): Promise<{ statusCode: number; payload: unknown }> {
  const answer = new RecordedAnswer();
  const returned = await route.handler(caller, answer);
  if (answer.payload === undefined && returned !== answer && returned !== undefined) {
    answer.payload = returned;
  }
  return { statusCode: answer.statusCode, payload: answer.payload };
}

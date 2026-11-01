import { API_BASE, ApiError, api, apiFetch } from '../api/client';

/**
 * The AI features' endpoints (M1-079; AI-013 to AI-016). Every call is made on the person's
 * request; the server refuses it where AI is not available (`aiRefusalMessage` says why).
 */
export interface SummaryCitation {
  commentId: number;
  author?: string;
}

export type SummaryOutcome =
  | {
      status: 'done';
      text: string;
      citations: SummaryCitation[];
      externalLinks: string[];
      omitted: number;
    }
  /** The provider declined: nothing it wrote is shown (AI-009 (2)). */
  | { status: 'refused' }
  /** The stream broke after it started; the body says why, as a refusal does. */
  | { status: 'failed'; body: unknown };

export interface GeneratedQuery {
  query: string;
  explanation: string;
  valid: boolean;
  repaired?: boolean;
  problem?: { stage: string; message: string };
}

export interface Named {
  id: number;
  name: string;
}

export interface TicketDraft {
  summary: string;
  /** Markdown. */
  description: string;
  ticketType: Named | null;
  priority: Named | null;
  labels: string[];
}

export interface ChildProposal {
  summary: string;
  description: string;
  ticketType: Named;
}

export interface Breakdown {
  parent: { id: number; key: string };
  track: { id: number; key: string };
  childTypes: Named[];
  children: ChildProposal[];
}

export interface AiClient {
  /** Streams a summary; `onText` gets each piece as it arrives. Abort `signal` to cancel. */
  summary(
    ticket: string | number,
    scope: 'ticket' | 'thread',
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<SummaryOutcome>;
  query(text: string): Promise<GeneratedQuery>;
  drafts(track: string, text: string): Promise<TicketDraft[]>;
  breakdown(ticket: string | number): Promise<Breakdown>;
  /** Creates one confirmed child through the ticket route, as the person (AI-015 (2)). */
  createChild(body: Record<string, unknown>): Promise<{ key: string }>;
}

/** Splits server-sent events out of a growing buffer: the complete ones, and the rest. */
export function parseEvents(buffer: string): {
  events: { event: string; data: unknown }[];
  rest: string;
} {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = blocks
    .filter((b) => b.trim() !== '')
    .map((block) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {
        parsed = null;
      }
      return { event, data: parsed };
    });
  return { events, rest };
}

export const aiClient: AiClient = {
  async summary(ticket, scope, onText, signal) {
    const response = await apiFetch(
      `${API_BASE}/tickets/${encodeURIComponent(String(ticket))}/ai/summary`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope }),
        signal,
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new ApiError(response.status, text ? JSON.parse(text) : null);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseEvents(done ? `${buffer}\n\n` : buffer);
      buffer = rest;
      for (const e of events) {
        const data = (e.data ?? {}) as Record<string, unknown>;
        if (e.event === 'text') onText(String(data.text ?? ''));
        else if (e.event === 'refused') return { status: 'refused' };
        else if (e.event === 'error') return { status: 'failed', body: data };
        else if (e.event === 'done') {
          return {
            status: 'done',
            text: String(data.text ?? ''),
            citations: (data.citations as SummaryCitation[] | undefined) ?? [],
            externalLinks: (data.externalLinks as string[] | undefined) ?? [],
            omitted: Number(data.omitted ?? 0),
          };
        }
      }
      if (done) return { status: 'failed', body: null };
    }
  },
  query: (text) => api<GeneratedQuery>('/ai/query', { method: 'POST', body: { text } }),
  drafts: async (track, text) =>
    (
      await api<{ drafts: TicketDraft[] }>('/ai/drafts', {
        method: 'POST',
        body: { track, text },
      })
    ).drafts,
  breakdown: (ticket) =>
    api<Breakdown>(`/tickets/${encodeURIComponent(String(ticket))}/ai/breakdown`, {
      method: 'POST',
      body: {},
    }),
  createChild: async (body) =>
    (
      await api<{ ticket: { key: string } }>('/tickets?format=markdown', {
        method: 'POST',
        body,
      })
    ).ticket,
};

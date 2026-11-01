import type { AiFeatures } from './AiFeature';
import type { AiClient, Breakdown, GeneratedQuery, SummaryOutcome, TicketDraft } from './client';

/** Every AI feature available: for stories and tests of the controls (M1-079). */
export const allAiFeatures = async (): Promise<AiFeatures> => ({
  summarize: { available: true },
  'query-from-text': { available: true },
  'assisted-creation': { available: true },
  duplicates: { available: true },
});

/** No provider set up: every control stays hidden (NFR-011). */
export const noAiFeatures = async (): Promise<AiFeatures> => ({
  summarize: { available: false, reason: 'not_configured' },
  'query-from-text': { available: false, reason: 'not_configured' },
  'assisted-creation': { available: false, reason: 'not_configured' },
  duplicates: { available: false, reason: 'not_configured' },
});

export const SUMMARY_TEXT =
  'Paying with an expired card shows a blank page [c11]. Sam found the check in the payment form [c12] and takes the fix; next, a test for every card state [c12].';

export const DRAFTS: TicketDraft[] = [
  {
    summary: 'Refund button does nothing on Safari',
    description:
      'Clicking **Refund** on Safari 18 does nothing.\n\n- Expected: the refund dialog opens.',
    ticketType: { id: 3, name: 'Bug' },
    priority: { id: 2, name: 'High' },
    labels: ['frontend'],
  },
  {
    summary: 'Ask for a reason when refunding',
    description: 'Support wants to know why a refund was given.',
    ticketType: { id: 2, name: 'Feature' },
    priority: null,
    labels: [],
  },
];

export const BREAKDOWN: Breakdown = {
  parent: { id: 7, key: 'SHOP-7' },
  track: { id: 1, key: 'SHOP' },
  childTypes: [
    { id: 2, name: 'Feature' },
    { id: 3, name: 'Bug' },
    { id: 4, name: 'Chore' },
  ],
  children: [
    {
      summary: 'Store cards securely',
      description: 'Use the payment vault.',
      ticketType: { id: 2, name: 'Feature' },
    },
    {
      summary: 'Pick a saved card at checkout',
      description: 'A list of the saved cards.',
      ticketType: { id: 2, name: 'Feature' },
    },
    {
      summary: 'Remove a saved card',
      description: 'From the account page.',
      ticketType: { id: 2, name: 'Feature' },
    },
  ],
};

/** A scripted AI client: streams the summary in pieces, answers the rest at once. */
export function fakeAiClient(
  options: {
    summary?: SummaryOutcome;
    query?: GeneratedQuery;
    /** Pause between streamed pieces, so the Cancel button can be pressed. */
    pieceMs?: number;
    fail?: unknown;
  } = {},
): AiClient & { created: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    async summary(_ticket, _scope, onText, signal) {
      if (options.fail) throw options.fail;
      const outcome: SummaryOutcome = options.summary ?? {
        status: 'done',
        text: SUMMARY_TEXT,
        citations: [
          { commentId: 11, author: 'Ana Ortiz' },
          { commentId: 12, author: 'Sam Rivera' },
        ],
        externalLinks: [],
        omitted: 0,
      };
      const text = outcome.status === 'done' ? outcome.text : 'Partial text';
      for (const piece of text.match(/\S+\s*/g) ?? []) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        onText(piece);
        await new Promise((resolve) => setTimeout(resolve, options.pieceMs ?? 5));
      }
      return outcome;
    },
    async query() {
      if (options.fail) throw options.fail;
      return (
        options.query ?? {
          query:
            'assignee = currentUser() AND type = Bug AND stage != closed AND updated >= startOfWeek()',
          explanation: 'Your open bugs changed since Sunday.',
          valid: true,
        }
      );
    },
    async drafts() {
      if (options.fail) throw options.fail;
      return DRAFTS;
    },
    async breakdown() {
      if (options.fail) throw options.fail;
      return structuredClone(BREAKDOWN);
    },
    async createChild(body) {
      created.push(body);
      return { key: `SHOP-${100 + created.length}` };
    },
  };
}

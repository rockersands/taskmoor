import type { Moved } from '../calendar/client';
import type { Rescheduled, TimelineItem } from '../timeline/client';
import type { ViewScenario } from './PlanSummaryPage';
import { type DraftInput, draftRefusalCode, type ScenarioClient } from './scenarioClient';

/**
 * The stage 1 seam in a scenario (ADR-122 stage 6): what the Timeline and the Calendar call to
 * change a ticket's days writes a draft in the scenario instead (`reschedule` becomes `draft`),
 * so nothing changes a ticket until its drafts are applied. Tickets are named by key on the views
 * and by id in a draft; `idOf` finds one from the other in what the view last read.
 */
export function draftCalls(
  planId: number,
  scenario: ViewScenario,
  scenarios: ScenarioClient,
  idOf: (key: string) => number | undefined,
  onDrafted?: () => void,
) {
  const write = async (key: string, change: Omit<DraftInput, 'ticketId'>): Promise<Rescheduled> => {
    const ticketId = idOf(key);
    if (ticketId === undefined) return { ok: false, code: 'not_found' };
    const written = await scenarios
      .draft(planId, scenario.id, [{ ticketId, ...change }])
      .catch(() => null);
    if (!written) return { ok: false, code: 'unreachable' };
    if (!written.ok) {
      return {
        ok: false,
        code: draftRefusalCode(written),
        ...(written.permission ? { permission: written.permission } : {}),
      };
    }
    onDrafted?.();
    return { ok: true };
  };
  return {
    reschedule: (key: string, dates: { startDate: string | null; dueDate: string | null }) =>
      write(key, dates),
    move: (
      key: string,
      days: { startDate?: string | null; dueDate?: string | null },
    ): Promise<Moved> => write(key, days),
    /** Writes the live values back: a field set back to live loses its draft. */
    undo: (item: Pick<TimelineItem, 'key' | 'draft'>) =>
      write(item.key, {
        ...(item.draft?.startDate ? { startDate: item.draft.startDate.now } : {}),
        ...(item.draft?.dueDate ? { dueDate: item.draft.dueDate.now } : {}),
      }),
  };
}

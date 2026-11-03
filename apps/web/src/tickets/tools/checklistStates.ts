import type { MessageId } from '../../i18n/messages.en';

export type ItemState = 'open' | 'in_progress' | 'done' | 'rejected';

/** The four states of a checklist item, in the order the list offers them (CORE-033). */
export const ITEM_STATES: readonly ItemState[] = ['open', 'in_progress', 'done', 'rejected'];

export const ITEM_STATE_LABELS: Record<ItemState, MessageId> = {
  open: 'ticketTools.state.open',
  in_progress: 'ticketTools.state.inProgress',
  done: 'ticketTools.state.done',
  rejected: 'ticketTools.state.rejected',
};

import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { Refusal } from './client';

/** The ticket route's refusals of new dates, in plain words (ADR-122). */
const REFUSALS: Record<string, MessageId> = {
  '403': 'schedule.refused.forbidden',
  track_archived: 'schedule.refused.archived',
  not_found: 'schedule.refused.gone',
  '404': 'schedule.refused.gone',
  invalid_fields: 'schedule.refused.invalid',
  invalid_request: 'schedule.refused.invalid',
  version_conflict: 'schedule.refused.conflict',
  '409': 'schedule.refused.conflict',
  // A draft in a plan's scenario (ADR-122 stage 6).
  start_after_due: 'schedule.refused.order',
  too_many_drafts: 'schedule.refused.tooManyDrafts',
};

/**
 * Why `key` kept its dates. A `forbidden` answer is a missing "Set due dates" only when it names
 * that permission (or none); a status or field lock (WF-007) answers `forbidden` too, with the
 * locks, and is said as a lock.
 */
export function scheduleRefusal(
  t: Translate,
  key: string,
  refusal: Pick<Refusal, 'code' | 'permission' | 'locked'>,
): string {
  if (refusal.code === 'forbidden') {
    if (refusal.locked) return t('schedule.refused.locked', { key });
    if (refusal.permission === 'edit_plan') return t('schedule.refused.notEditor', { key });
    if (refusal.permission === undefined || refusal.permission === 'schedule_tickets') {
      return t('schedule.refused.forbidden', { key });
    }
    return t('timeline.rescheduleFailed', { key });
  }
  return t(REFUSALS[refusal.code] ?? 'timeline.rescheduleFailed', { key });
}

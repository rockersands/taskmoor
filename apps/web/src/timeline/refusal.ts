import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

/** The ticket route's refusals of new dates, in plain words (ADR-122). */
const REFUSALS: Record<string, MessageId> = {
  forbidden: 'schedule.refused.forbidden',
  '403': 'schedule.refused.forbidden',
  track_archived: 'schedule.refused.archived',
  not_found: 'schedule.refused.gone',
  '404': 'schedule.refused.gone',
  invalid_fields: 'schedule.refused.invalid',
  invalid_request: 'schedule.refused.invalid',
  version_conflict: 'schedule.refused.conflict',
  '409': 'schedule.refused.conflict',
};

/** Why `key` kept its dates, from the code the ticket route answered with. */
export function scheduleRefusal(t: Translate, key: string, code: string): string {
  return t(REFUSALS[code] ?? 'timeline.rescheduleFailed', { key });
}

import { useIntl } from 'react-intl';
import { dayText } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { MoveReason } from './crossTrackClient';

/** A calendar day as people read it; shared with every page that shows one (T-240). */
export { dayText } from '../i18n/days';

/** Why a move left a release where it is, in words. */
export const MOVE_REASONS: Record<MoveReason, MessageId> = {
  no_permission: 'crossTrack.move.reason.noPermission',
  shipped: 'crossTrack.move.reason.shipped',
  archived: 'crossTrack.move.reason.archived',
  track_archived: 'crossTrack.move.reason.trackArchived',
  start_after_date: 'crossTrack.move.reason.startAfterDate',
};

/** The end as people read it: a day, or in words when it ends with its work. */
export function useEndText() {
  const t = useT();
  const intl = useIntl();
  return (row: { date: string | null }) =>
    row.date ? dayText(intl, row.date) : t('crossTrack.end.whenComplete');
}

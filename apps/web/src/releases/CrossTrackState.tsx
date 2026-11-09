import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { CrossTrackStateName } from './crossTrackClient';

const STATES: Record<CrossTrackStateName, MessageId> = {
  empty: 'crossTrack.state.empty',
  shipped: 'crossTrack.state.shipped',
  overdue: 'crossTrack.state.overdue',
  ready: 'crossTrack.state.ready',
  upcoming: 'crossTrack.state.upcoming',
};

const BADGES: Record<CrossTrackStateName, string> = {
  empty: 'badge',
  shipped: 'badge badge-success',
  overdue: 'badge badge-warning',
  ready: 'badge badge-success',
  upcoming: 'badge badge-accent',
};

/** A release across tracks' state as a word, never colour alone (PLN-007). */
export function CrossTrackState({ state }: { state: CrossTrackStateName }) {
  const t = useT();
  return (
    <span className={`${BADGES[state]} release-state`} data-state={state}>
      {t(STATES[state])}
    </span>
  );
}

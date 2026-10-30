import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { Release } from './client';

const STATES = {
  upcoming: 'releases.state.upcoming',
  overdue: 'releases.state.overdue',
  shipped: 'releases.state.shipped',
  archived: 'releases.state.archived',
} as const satisfies Record<string, MessageId>;

/** A release's state as a word (never colour alone): archived, shipped, overdue or upcoming. */
export function ReleaseState({
  release,
}: {
  release: Pick<Release, 'shipped' | 'archived' | 'overdue'>;
}) {
  const t = useT();
  const state: keyof typeof STATES = release.archived
    ? 'archived'
    : release.shipped
      ? 'shipped'
      : release.overdue
        ? 'overdue'
        : 'upcoming';
  return (
    <span className="release-state" data-state={state}>
      {t(STATES[state])}
    </span>
  );
}

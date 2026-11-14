import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { type Lock, useLockText } from '../locks/useLockText';
import type {
  ChangeField,
  ChangePage,
  ChangeRefusal,
  DraftValue,
  PlanChange,
} from './scenarioClient';

/** The track key of a ticket's key: `SPA` of `SPA-12`. */
export const trackKeyOf = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf('-')));

/**
 * The words of the change list (ADR-122 stage 6): each drafted field as "Due: 3 Dec → 10 Dec", a
 * change's state ("Ready", "Changed since drafted: due is now 5 Dec", "Already so", a permission
 * the reader lacks, a refusal and its reason), never by colour alone.
 */
export function useChangeWords(page: Pick<ChangePage, 'teams' | 'teamFields'> | null) {
  const t = useT();
  const intl = useIntl();
  const lockText = useLockText();
  const teams = new Map((page?.teams ?? []).map((x) => [x.id, x.name]));
  const fields = new Map((page?.teamFields ?? []).map((x) => [x.id, x.name]));

  const day = (text: string) =>
    intl.formatDate(new Date(`${text}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  /** A value as the page says it: a day, a team's name, or "none". */
  const value = (field: Pick<ChangeField, 'teamFieldId'>, v: DraftValue) => {
    if (v === null) return t('scenario.value.none');
    if (field.teamFieldId !== null) {
      return teams.get(Number(v)) ?? t('scenario.value.team', { id: String(v) });
    }
    return day(String(v));
  };

  /** The field's name: Start, Due, or the Team field's own. */
  const fieldName = (f: Pick<ChangeField, 'field' | 'teamFieldId'>) =>
    f.field === 'startDate'
      ? t('scenario.field.start')
      : f.field === 'dueDate'
        ? t('scenario.field.due')
        : (fields.get(f.teamFieldId ?? 0) ?? t('scenario.field.team'));

  /** "Due: 3 Dec → 10 Dec", with the value when drafted where it changed since. */
  const line = (f: ChangeField) =>
    f.state === 'changed'
      ? t('scenario.line.changed', {
          field: fieldName(f),
          now: value(f, f.now),
          draft: value(f, f.draft),
          was: value(f, f.was),
        })
      : t('scenario.line', { field: fieldName(f), now: value(f, f.now), draft: value(f, f.draft) });

  /** The values now of fields that changed since drafted: "due is now 5 Dec". */
  const nowList = (pairs: { f: Pick<ChangeField, 'field' | 'teamFieldId'>; v: DraftValue }[]) =>
    intl.formatList(
      pairs.map(({ f, v }) =>
        t('scenario.isNow', { field: fieldName(f).toLowerCase(), value: value(f, v) }),
      ),
      { type: 'conjunction' },
    );

  /** Why an apply left a ticket as it was. */
  const refusal = (r: ChangeRefusal, key: string | null) => {
    const track = key ? trackKeyOf(key) : '';
    switch (r.reason) {
      case 'no_permission':
        return r.permission === 'schedule_tickets'
          ? t('scenario.needs.schedule', { track })
          : r.permission === 'edit_tickets'
            ? t('scenario.needs.edit', { track })
            : t('scenario.refusal.permission', { track });
      case 'locked': {
        const lock = Array.isArray(r.locks) ? (r.locks[0] as Lock | undefined) : undefined;
        return lock
          ? t('scenario.refusal.lockedBy', { why: lockText(lock) })
          : t('scenario.refusal.locked');
      }
      case 'track_archived':
        return t('scenario.refusal.archived');
      case 'gone':
        return t('scenario.refusal.gone');
      case 'changed_meanwhile': {
        const now = Object.entries(r.now ?? {});
        return now.length === 0
          ? t('scenario.refusal.changed')
          : t('scenario.state.changed', {
              values: nowList(
                now.map(([field, v]) => ({
                  f: {
                    field,
                    teamFieldId: field.startsWith('cf:') ? Number(field.slice(3)) : null,
                  },
                  v,
                })),
              ),
            });
      }
      case 'invalid':
        return t('scenario.refusal.invalid');
      default:
        return t('scenario.refusal.failed');
    }
  };

  /** A change's state in words. */
  const state = (c: PlanChange) => {
    if (c.state === 'changed') {
      return t('scenario.state.changed', {
        values: nowList(
          c.fields.filter((f) => f.state === 'changed').map((f) => ({ f, v: f.now })),
        ),
      });
    }
    if (c.state === 'refused' && c.refusal) {
      return t('scenario.state.refused', { reason: refusal(c.refusal, c.key) });
    }
    if (c.state === 'already') return t('scenario.state.already');
    if (c.needs === 'schedule_tickets') {
      return t('scenario.needs.schedule', { track: trackKeyOf(c.key) });
    }
    if (c.needs === 'edit_tickets') return t('scenario.needs.edit', { track: trackKeyOf(c.key) });
    return t('scenario.state.ready');
  };

  const when = (at: string) =>
    intl.formatDate(at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  return { line, state, refusal, when, day };
}

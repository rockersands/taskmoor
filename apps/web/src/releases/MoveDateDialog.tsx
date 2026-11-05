import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';
import {
  type CrossTrackClient,
  type MoveAnswer,
  type MoveLine,
  UNREACHABLE,
} from './crossTrackClient';
import { dayText, MOVE_REASONS } from './crossTrackText';

export interface MoveDateDialogProps {
  id: number;
  name: string;
  /** The day it ends now; null when it ends when its work completes. */
  date: string | null;
  client: CrossTrackClient;
  /** A move happened: the page reads itself again. */
  onMoved: () => void;
  onClose: () => void;
}

/**
 * Moving a release across tracks' date (PLN-007 (2)): the new day, then the list of what it would
 * do, which changes nothing, one line per release with its old and new day and its outcome in words,
 * then the move. Each release moves only if the person could change it, and the rest stay and read
 * out of step. The result stays open, with focus on its heading. A move to the day it already has
 * brings back the releases out of step; with none to bring, it changes nothing and offers no move.
 * One line, always in the page, says what the list adds up to, so it is read out when it changes.
 */
export function MoveDateDialog({ id, name, date, client, onMoved, onClose }: MoveDateDialogProps) {
  const t = useT();
  const intl = useIntl();
  const domId = useId();
  const [day, setDay] = useState(date ?? '');
  const [list, setList] = useState<MoveAnswer | null>(null);
  const [done, setDone] = useState<MoveAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (done) heading.current?.focus();
  }, [done]);

  const refusal = (code: string) =>
    code === 'already_shipped'
      ? t('crossTrack.move.alreadyShipped')
      : code === 'version_conflict'
        ? t('crossTrack.move.stale')
        : code === UNREACHABLE
          ? t('crossTrack.unreachable')
          : t('crossTrack.move.failed');

  const listChanges = async () => {
    if (!day) return;
    setBusy(true);
    setProblem(null);
    const answer = await client.changes(id, day);
    setBusy(false);
    if (answer.ok) setList(answer.value);
    else {
      setList(null);
      setProblem(refusal(answer.code));
    }
  };

  const move = async () => {
    if (!list) return;
    setBusy(true);
    setProblem(null);
    const answer = await client.move(id, list.to, list.version);
    setBusy(false);
    if (answer.ok) {
      setDone(answer.value);
      onMoved();
      return;
    }
    setProblem(refusal(answer.code));
    // Someone changed it meanwhile: the list is read again, so what is confirmed is what happens.
    if (answer.code === 'version_conflict') {
      const again = await client.changes(id, list.to);
      setList(again.ok ? again.value : null);
    }
  };

  const shown = done ?? list;
  const moves = shown?.lines.filter((l) => l.outcome === 'moves').length ?? 0;
  const sameDay = list !== null && list.from === list.to;
  const unchanged = sameDay && moves === 0;
  const summary = done
    ? t('crossTrack.move.done', { count: moves })
    : !list
      ? ''
      : unchanged
        ? t('crossTrack.move.sameDay')
        : moves === 0
          ? t('crossTrack.move.nothingFollows')
          : sameDay
            ? t('crossTrack.move.sameDayMoves', { count: moves })
            : t('crossTrack.move.listed', { count: moves });

  const lineText = (line: MoveLine, happened: boolean) => {
    const from = line.from ? dayText(intl, line.from) : t('crossTrack.move.noDay');
    const to = dayText(intl, line.to);
    if (line.outcome === 'moves') {
      return t(happened ? 'crossTrack.move.line.moved' : 'crossTrack.move.line.moves', {
        from,
        to,
      });
    }
    if (line.outcome === 'same') return t('crossTrack.move.line.same', { to });
    return t('crossTrack.move.line.stays', {
      from,
      reason: t(line.reason ? MOVE_REASONS[line.reason] : 'crossTrack.move.reason.noPermission'),
    });
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${domId}-title`}
      closeLabel={t('crossTrack.move.close')}
      focusFirstField={!done}
      className="cross-track-dialog"
    >
      {done ? (
        <h2 id={`${domId}-title`} ref={heading} tabIndex={-1}>
          {t('crossTrack.move.doneTitle', { name, date: dayText(intl, done.to) })}
        </h2>
      ) : (
        <h2 id={`${domId}-title`}>{t('crossTrack.move.title', { name })}</h2>
      )}
      {!done && (
        <form
          className="cross-track-move-form"
          onSubmit={(event) => {
            event.preventDefault();
            void listChanges();
          }}
        >
          <label className="form-field" htmlFor={`${domId}-day`}>
            <span className="form-label">{t('crossTrack.move.day')}</span>
            <input
              id={`${domId}-day`}
              type="date"
              value={day}
              required
              onChange={(event) => {
                setDay(event.target.value);
                setList(null);
              }}
            />
          </label>
          <button type="submit" className="button-secondary" disabled={busy || !day}>
            {t('crossTrack.move.list')}
          </button>
        </form>
      )}
      <p className="board-hint" role="status">
        {summary}
      </p>
      {shown && (
        <>
          <ul className="cross-track-lines">
            {shown.lines.map((line) => (
              <li key={line.id} data-outcome={line.outcome}>
                <strong>
                  {t('crossTrack.linked.name', { track: line.track.name, name: line.name })}
                </strong>
                <span>{lineText(line, done !== null)}</span>
              </li>
            ))}
          </ul>
          {shown.hidden.releases > 0 && (
            <p className="board-hint">
              {t('crossTrack.move.hidden', { count: shown.hidden.releases })}
            </p>
          )}
        </>
      )}
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="form-actions cross-track-dialog-actions">
        {!done && list && !unchanged && (
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => void move()}
          >
            {t('crossTrack.move.submit', { count: moves })}
          </button>
        )}
        <button type="button" className="button-secondary" onClick={onClose}>
          {t(done ? 'crossTrack.move.finish' : 'crossTrack.move.cancel')}
        </button>
      </div>
    </ModalDialog>
  );
}

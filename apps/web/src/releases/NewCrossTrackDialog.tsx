import { useId, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import {
  type Candidate,
  type CrossTrackClient,
  type CrossTrackEndRule,
  UNREACHABLE,
} from './crossTrackClient';
import { dayText } from './crossTrackText';
import { candidateMatches, useCandidates } from './useCandidates';

export interface NewCrossTrackDialogProps {
  client: CrossTrackClient;
  onMade: (id: number) => void;
  onClose: () => void;
}

/**
 * Making a release across tracks (PLN-007): a name, a description, its end and the upcoming
 * releases to line up, of tracks the person administers, in a list that filters. One per track.
 * On a phone it is a full-height sheet. Linking never moves a date: a release on another day reads
 * as out of step until someone moves it.
 */
export function NewCrossTrackDialog({ client, onMade, onClose }: NewCrossTrackDialogProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const { candidates, truncated, failed, filter, setFilter } = useCandidates(client);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endRule, setEndRule] = useState<CrossTrackEndRule>('fixed_date');
  const [date, setDate] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = useMemo(
    () => (candidates ?? []).filter((c) => candidateMatches(c, filter) || picked.has(c.id)),
    [candidates, filter, picked],
  );

  /** One release per track: ticking another of the same track replaces it. */
  const toggle = (candidate: Candidate) => {
    const next = new Set(picked);
    if (next.has(candidate.id)) next.delete(candidate.id);
    else {
      for (const c of candidates ?? []) {
        if (c.track.id === candidate.track.id) next.delete(c.id);
      }
      next.add(candidate.id);
    }
    setPicked(next);
  };

  const save = async () => {
    if (picked.size === 0) {
      setProblem(t('crossTrack.new.pickOne'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const answer = await client.create({
      name: name.trim(),
      ...(description.trim() ? { description } : {}),
      endRule,
      ...(endRule === 'fixed_date' ? { date } : {}),
      releaseIds: [...picked],
    });
    setBusy(false);
    if (answer.ok) {
      onMade(answer.value.id);
      return;
    }
    setProblem(
      answer.code === 'release_taken' || answer.code === 'track_taken'
        ? t('crossTrack.new.taken')
        : answer.code === UNREACHABLE
          ? t('crossTrack.unreachable')
          : t('crossTrack.new.failed'),
    );
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('crossTrack.new.close')}
      focusFirstField
      className="cross-track-dialog"
    >
      <form
        className="cross-track-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>{t('crossTrack.new')}</h2>
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('crossTrack.new.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={255}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${id}-description`}>
          <span className="form-label">{t('crossTrack.new.description')}</span>
          <textarea
            id={`${id}-description`}
            value={description}
            maxLength={4000}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <fieldset className="capacity-dialog-group">
          <legend>{t('crossTrack.new.end')}</legend>
          <label className="form-field-inline">
            <input
              type="radio"
              name={`${id}-end`}
              checked={endRule === 'fixed_date'}
              onChange={() => setEndRule('fixed_date')}
            />
            {t('crossTrack.end.fixed')}
          </label>
          {endRule === 'fixed_date' && (
            <label className="form-field" htmlFor={`${id}-date`}>
              <span className="form-label">{t('crossTrack.new.date')}</span>
              <input
                id={`${id}-date`}
                type="date"
                value={date}
                required
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
          )}
          <label className="form-field-inline">
            <input
              type="radio"
              name={`${id}-end`}
              checked={endRule === 'work_complete'}
              onChange={() => setEndRule('work_complete')}
            />
            {t('crossTrack.end.workComplete')}
          </label>
        </fieldset>
        <fieldset className="capacity-dialog-group">
          <legend>{t('crossTrack.new.releases')}</legend>
          {failed && (
            <p className="board-problem" role="alert">
              {t('crossTrack.new.candidatesFailed')}
            </p>
          )}
          {candidates === null && !failed && (
            <p className="report-loading">{t('reports.loading')}</p>
          )}
          {candidates?.length === 0 && !failed && (
            <EmptyState compact title={t('crossTrack.new.noneToLink')}>
              {t('empty.crossTrack.candidates')}
            </EmptyState>
          )}
          {candidates !== null && candidates.length > 0 && (
            <>
              <label className="form-field" htmlFor={`${id}-filter`}>
                <span className="form-label">{t('crossTrack.new.filter')}</span>
                <input
                  id={`${id}-filter`}
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              {shown.length === 0 && <p className="board-hint">{t('crossTrack.new.noMatch')}</p>}
              <ul className="cross-track-candidates">
                {shown.map((c) => (
                  <li key={c.id}>
                    <label className="form-field-inline">
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        onChange={() => toggle(c)}
                      />
                      <span>
                        {t('crossTrack.linked.name', { track: c.track.name, name: c.name })}
                        <span className="board-meta">
                          {' '}
                          {c.releaseDate
                            ? t('releases.dueOn', { date: dayText(intl, c.releaseDate) })
                            : t('releases.noDate')}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {truncated && <p className="board-hint">{t('crossTrack.new.truncated')}</p>}
            </>
          )}
        </fieldset>
        <p className="board-hint">{t('crossTrack.new.noMove')}</p>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions cross-track-dialog-actions">
          <button type="submit" className="button-primary" disabled={busy || name.trim() === ''}>
            {t('crossTrack.new.submit')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('crossTrack.move.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

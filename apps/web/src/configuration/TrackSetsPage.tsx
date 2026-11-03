import { type FormEvent, useEffect, useId, useState } from 'react';
import { useNotSetupAdmin } from '../admin/access';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type SetChange,
  type SetChoices,
  type TrackSet,
  type TrackSetsClient,
  type TrackWithSets,
  trackSetsClient,
} from './trackSetsClient';

type SetKey = keyof SetChange;

/** The four choices of the page; `none` names what an empty choice means for each. */
const SETS: {
  key: SetKey;
  list: keyof SetChoices;
  labelId: MessageId;
  noneId: MessageId;
  hintId: MessageId;
}[] = [
  {
    key: 'layoutSetId',
    list: 'layoutSets',
    labelId: 'admin.trackSets.layout',
    noneId: 'admin.trackSets.layoutNone',
    hintId: 'admin.trackSets.layoutHint',
  },
  {
    key: 'prioritySetId',
    list: 'prioritySets',
    labelId: 'admin.trackSets.priority',
    noneId: 'admin.trackSets.priorityNone',
    hintId: 'admin.trackSets.priorityHint',
  },
  {
    key: 'visibilityPolicyId',
    list: 'visibilityPolicies',
    labelId: 'admin.trackSets.visibility',
    noneId: 'admin.trackSets.visibilityNone',
    hintId: 'admin.trackSets.visibilityHint',
  },
  {
    key: 'notificationPolicyId',
    list: 'notificationPolicies',
    labelId: 'admin.trackSets.notification',
    noneId: 'admin.trackSets.notificationNone',
    hintId: 'admin.trackSets.notificationHint',
  },
];

/**
 * Which layout, priority, visibility and notification sets a track uses (CORE-013, CORE-014,
 * IAM-011, NTF-001), for site and configuration administrators. A plain picker from the lists:
 * pages that edit those sets come separately.
 */
export function TrackSetsPage({
  client = trackSetsClient,
  initialTrackId = null,
}: {
  client?: TrackSetsClient;
  initialTrackId?: number | null;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const id = useId();
  const notAdmin = useNotSetupAdmin();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; tracks: TrackWithSets[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [selected, setSelected] = useState<number | null>(initialTrackId);

  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    client.tracks().then(
      (tracks) => {
        if (!live) return;
        setState({ status: 'loaded', tracks });
        setSelected((current) =>
          current !== null && tracks.some((x) => x.id === current)
            ? current
            : (tracks[0]?.id ?? null),
        );
      },
      (error) => {
        if (!live || expired(error)) return;
        setState({
          status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed',
        });
      },
    );
    return () => {
      live = false;
    };
  }, [client, expired, notAdmin]);

  const track = state.status === 'loaded' ? state.tracks.find((x) => x.id === selected) : undefined;
  return (
    <section aria-labelledby={titleId} className="admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.trackSets.title')}
        purpose={t('admin.trackSets.purpose')}
        about={t('admin.trackSets.about')}
      />
      {state.status === 'forbidden' && (
        <p className="page-note">{t('admin.trackSets.forbidden')}</p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('admin.trackSets.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.trackSets.loadFailed')}
        </p>
      )}
      {state.status === 'loaded' && state.tracks.length === 0 && (
        <EmptyState title={t('admin.trackSets.emptyTitle')}>
          {t('admin.trackSets.empty')}
        </EmptyState>
      )}
      {state.status === 'loaded' && state.tracks.length > 0 && (
        <>
          <div className="form-field">
            <label htmlFor={`${id}-track`} className="form-label">
              {t('admin.trackSets.track')}
            </label>
            <select
              id={`${id}-track`}
              value={selected ?? ''}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {state.tracks.map((x) => (
                <option key={x.id} value={x.id}>
                  {t('admin.explain.trackOption', { key: x.key, name: x.name })}
                </option>
              ))}
            </select>
          </div>
          {track && (
            <TrackSetsForm
              key={track.id}
              track={track}
              client={client}
              onSaved={(change) =>
                setState({
                  status: 'loaded',
                  tracks: state.tracks.map((x) => (x.id === track.id ? { ...x, ...change } : x)),
                })
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function TrackSetsForm({
  track,
  client,
  onSaved,
}: {
  track: TrackWithSets;
  client: TrackSetsClient;
  onSaved: (change: SetChange) => void;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const [choices, setChoices] = useState<SetChoices | 'failed' | null>(null);
  const [draft, setDraft] = useState<Record<SetKey, string>>({
    layoutSetId: String(track.layoutSetId ?? ''),
    prioritySetId: String(track.prioritySetId ?? ''),
    visibilityPolicyId: String(track.visibilityPolicyId ?? ''),
    notificationPolicyId: String(track.notificationPolicyId ?? ''),
  });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.choices(track).then(
      (found) => live && setChoices(found),
      (error) => {
        if (live && !expired(error)) setChoices('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [client, track, expired]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const change: SetChange = {};
    for (const { key } of SETS) {
      const value = draft[key] === '' ? null : Number(draft[key]);
      if (value !== track[key]) change[key] = value;
    }
    setMessage('');
    setProblem(null);
    if (Object.keys(change).length === 0) {
      setMessage(t('admin.trackSets.nothing'));
      return;
    }
    try {
      await client.save(track.id, change);
      onSaved(change);
      setMessage(t('admin.trackSets.saved', { key: track.key }));
    } catch (error) {
      if (expired(error)) return;
      setProblem(
        t(
          error instanceof ApiError && error.status === 403
            ? 'admin.trackSets.problem.forbidden'
            : 'admin.trackSets.problem.other',
        ),
      );
    }
  };

  if (choices === 'failed') {
    return (
      <p role="alert" className="form-error">
        {t('admin.trackSets.choicesFailed')}
      </p>
    );
  }
  if (!choices) return <p className="page-note">{t('admin.trackSets.loading')}</p>;
  return (
    <form
      className="form glass-card admin-panel"
      aria-label={t('admin.trackSets.formOf', { key: track.key })}
      onSubmit={(event) => void submit(event)}
    >
      {SETS.map(({ key, list, labelId, noneId, hintId }) => (
        <div key={key} className="form-field">
          <label htmlFor={`${id}-${key}`} className="form-label">
            {t(labelId)}
          </label>
          <select
            id={`${id}-${key}`}
            value={draft[key]}
            aria-describedby={`${id}-${key}-hint`}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          >
            <option value="">{t(noneId)}</option>
            {choices[list].map((set: TrackSet) => (
              <option key={set.id} value={set.id}>
                {set.trackId ? t('admin.trackSets.own', { name: set.name }) : set.name}
              </option>
            ))}
          </select>
          <p id={`${id}-${key}-hint`} className="form-hint">
            {t(hintId)}
          </p>
        </div>
      ))}
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="people-actions">
        <button type="submit" className="button-primary">
          {t('admin.trackSets.save')}
        </button>
      </div>
    </form>
  );
}

import { type FormEvent, Fragment, useEffect, useId, useState } from 'react';
import { useAdminAccess, useNotSetupAdmin } from '../admin/access';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { TypeMapping, type TypesInUse, ticketsOf } from '../sets/TypeSetForm';
import { ownSetsHref } from '../sets/trackScope';
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

type SetKey = 'layoutSetId' | 'prioritySetId' | 'visibilityPolicyId' | 'notificationPolicyId';
/** The sets only a shared-mode track switches here, and never to none (T-322). */
type SharedKey = 'accessPolicyId' | 'typeSetId';

/** The page that makes and changes a kind of set, when there is one. */
interface MadeOn {
  href: string;
  linkId: MessageId;
  /** Only site administrators open that page. */
  siteOnly?: boolean;
}

/** The four choices of every track; `none` names what an empty choice means for each. */
const SETS: {
  key: SetKey;
  list: 'layoutSets' | 'prioritySets' | 'visibilityPolicies' | 'notificationPolicies';
  labelId: MessageId;
  noneId: MessageId;
  hintId: MessageId;
  made?: MadeOn;
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
    made: { href: '#/admin/priorities', linkId: 'admin.trackSets.priorityLink' },
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
    made: {
      href: '#/admin/notification-policies',
      linkId: 'admin.trackSets.notificationLink',
    },
  },
];

/** A shared-mode track's access policy and type set (T-322): a local-mode track keeps its own. */
const SHARED_SETS: {
  key: SharedKey;
  list: 'accessPolicies' | 'typeSets';
  labelId: MessageId;
  hintId: MessageId;
  made: MadeOn;
}[] = [
  {
    key: 'accessPolicyId',
    list: 'accessPolicies',
    labelId: 'admin.trackSets.access',
    hintId: 'admin.trackSets.accessHint',
    made: { href: '#/admin/permissions', linkId: 'admin.trackSets.accessLink', siteOnly: true },
  },
  {
    key: 'typeSetId',
    list: 'typeSets',
    labelId: 'admin.trackSets.typeSet',
    hintId: 'admin.trackSets.typeSetHint',
    made: { href: '#/admin/configuration-sets', linkId: 'admin.trackSets.typeSetLink' },
  },
];

/**
 * Which sets a track uses (CORE-005, CORE-013, CORE-014, IAM-010, IAM-011, NTF-001), for site and
 * configuration administrators: a shared-mode track's access policy and type set, and every
 * track's layout, priority, visibility and notification sets. A plain picker from the lists:
 * pages that edit those sets come separately. A type set that lacks types the track's tickets
 * have asks first which type they take (T-322).
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
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.trackSets.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('admin.trackSets.purpose'), about: t('admin.trackSets.about') })}
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

/** The server's word that tickets still have types the new type set lacks (CORE-005 (2)). */
interface InUse {
  error?: string;
  detail?: string;
  ticketTypeIds?: number[];
  ticketCount?: number;
}

const draftOf = (track: TrackWithSets): Record<SetKey | SharedKey, string> => ({
  accessPolicyId: String(track.accessPolicyId ?? ''),
  typeSetId: String(track.typeSetId ?? ''),
  layoutSetId: String(track.layoutSetId ?? ''),
  prioritySetId: String(track.prioritySetId ?? ''),
  visibilityPolicyId: String(track.visibilityPolicyId ?? ''),
  notificationPolicyId: String(track.notificationPolicyId ?? ''),
});

function TrackSetsForm({
  track,
  client,
  onSaved,
}: {
  track: TrackWithSets;
  client: TrackSetsClient;
  onSaved: (change: Omit<SetChange, 'ticketTypeMapping'>) => void;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const siteAdmin = useAdminAccess() === 'site';
  const shared = track.mode === 'shared';
  const [choices, setChoices] = useState<SetChoices | 'failed' | null>(null);
  const [draft, setDraft] = useState(() => draftOf(track));
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * Each refusal since the type set was chosen of the types it lacks whose tickets need another
   * type. A refusal names only the types the mapping left out, so the question keeps every type
   * any refusal named, with its choice, until the track is saved or another set is chosen.
   */
  const [refusals, setRefusals] = useState<TypesInUse[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});

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

  const typeSet =
    choices && choices !== 'failed'
      ? choices.typeSets.find((s) => String(s.id) === draft.typeSetId)
      : undefined;
  const setName = typeSet?.name ?? '';
  const kept = typeSet?.ticketTypeIds ?? [];
  const dropped = [...new Set(refusals.flatMap((r) => r.typeIds))].filter(
    (typeId) => !kept.includes(typeId),
  );

  const refusalOf = (error: unknown) => {
    if (!(error instanceof ApiError)) return t('admin.trackSets.problem.other');
    const body = error.body as InUse | null;
    if (body?.error === 'type_in_use') {
      return t('admin.trackSets.problem.typeInUse', { key: track.key, set: setName });
    }
    if (body?.error === 'invalid_mapping') {
      return t('admin.trackSets.problem.mapping', { set: setName });
    }
    if (body?.error === 'track_archived') {
      return t('admin.trackSets.problem.archived', { key: track.key });
    }
    if (error.status === 400) return t('admin.trackSets.problem.gone');
    if (error.status === 403) return t('admin.trackSets.problem.forbidden');
    if (error.status === 404) return t('admin.trackSets.problem.trackGone', { key: track.key });
    return t('admin.trackSets.problem.other');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const change: SetChange = {};
    for (const { key } of SETS) {
      const value = draft[key] === '' ? null : Number(draft[key]);
      if (value !== track[key]) change[key] = value;
    }
    if (shared) {
      for (const { key } of SHARED_SETS) {
        if (draft[key] !== '' && Number(draft[key]) !== track[key])
          change[key] = Number(draft[key]);
      }
    }
    const mapped =
      change.typeSetId === undefined
        ? []
        : Object.entries(mapping).filter(([from]) => dropped.includes(Number(from)));
    if (mapped.length > 0) change.ticketTypeMapping = Object.fromEntries(mapped);
    setMessage('');
    setProblem(null);
    if (Object.keys(change).length === 0) {
      setMessage(t('admin.trackSets.nothing'));
      return;
    }
    try {
      await client.save(track.id, change);
      const moved = ticketsOf(
        refusals,
        mapped.map(([from]) => Number(from)),
      );
      setRefusals([]);
      setMapping({});
      const { ticketTypeMapping: _mapping, ...made } = change;
      onSaved(made);
      setMessage(
        mapped.length === 0
          ? t('admin.trackSets.saved', { key: track.key })
          : moved === null
            ? t('admin.trackSets.savedMappedUncounted', { key: track.key })
            : t('admin.trackSets.savedMapped', { key: track.key, tickets: moved }),
      );
    } catch (error) {
      if (expired(error)) return;
      const body = error instanceof ApiError ? (error.body as InUse | null) : null;
      if (body?.error === 'type_in_use') {
        const refusal = { typeIds: body.ticketTypeIds ?? [], tickets: body.ticketCount ?? 0 };
        setRefusals((before) => [...before, refusal]);
      }
      setProblem(refusalOf(error));
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
  const tickets = ticketsOf(refusals, dropped);
  return (
    <form
      className="form glass-card admin-panel"
      aria-label={t('admin.trackSets.formOf', { key: track.key })}
      onSubmit={(event) => void submit(event)}
    >
      {shared ? (
        SHARED_SETS.map(({ key, list, labelId, hintId, made }) => (
          <Fragment key={key}>
            <div className="form-field">
              <label htmlFor={`${id}-${key}`} className="form-label">
                {t(labelId)}
              </label>
              <select
                id={`${id}-${key}`}
                value={draft[key]}
                aria-describedby={`${id}-${key}-hint`}
                onChange={(e) => {
                  setDraft({ ...draft, [key]: e.target.value });
                  // The mapping was for the set chosen before: another set lacks other types.
                  if (key === 'typeSetId') {
                    setRefusals([]);
                    setMapping({});
                  }
                }}
              >
                {draft[key] === '' && (
                  <option value="" disabled>
                    {t('admin.trackSets.choose')}
                  </option>
                )}
                {choices[list].map((set: TrackSet) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
              <p id={`${id}-${key}-hint`} className="form-hint">
                {t(hintId)}
              </p>
              {(!made.siteOnly || siteAdmin) && (
                <p className="form-hint form-hint-link">
                  <a href={routeHref(made.href)}>{t(made.linkId)}</a>
                </p>
              )}
            </div>
            {key === 'typeSetId' && dropped.length > 0 && (
              <TypeMapping
                dropped={dropped}
                tickets={tickets}
                types={choices.ticketTypes}
                kept={kept}
                mapping={mapping}
                onChange={setMapping}
                words={{
                  intro:
                    tickets === null
                      ? t('admin.trackSets.mappingIntroUncounted', {
                          key: track.key,
                          set: setName,
                        })
                      : t('admin.trackSets.mappingIntro', {
                          key: track.key,
                          set: setName,
                          tickets,
                        }),
                  legend: t('admin.trackSets.mapping', { set: setName }),
                  nowhere: (name, level) =>
                    t('admin.trackSets.mappingNowhere', { name, level, set: setName }),
                }}
              />
            )}
          </Fragment>
        ))
      ) : (
        <div className="form-field">
          <p className="page-note">{t('admin.trackSets.ownKept', { key: track.key })}</p>
          <p className="form-hint form-hint-link">
            <a href={routeHref(ownSetsHref(track.id))}>
              {t('admin.trackSets.ownLink', { key: track.key })}
            </a>
          </p>
        </div>
      )}
      {SETS.map(({ key, list, labelId, noneId, hintId, made }) => (
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
          {made && (
            <p className="form-hint form-hint-link">
              <a href={routeHref(made.href)}>{t(made.linkId)}</a>
            </p>
          )}
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

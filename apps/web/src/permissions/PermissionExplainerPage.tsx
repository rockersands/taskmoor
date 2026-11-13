import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { PageHeader } from '../shell/PageHeader';
import type { Named } from './client';
import {
  type ExplainClient,
  type ExplainReason,
  type Explanation,
  explainClient,
} from './visibilityClient';

type Translate = ReturnType<typeof useT>;

function reasonText(t: Translate, reason: ExplainReason): string {
  if (reason.kind === 'site_admin') return t('admin.explain.reason.siteAdmin');
  if (reason.kind === 'configuration_admin') return t('admin.explain.reason.configAdmin');
  const name = reason.roleName ?? reason.groupName ?? '';
  return t(`admin.explain.grant.${reason.grantee}` as MessageId, { name });
}

/** The permission explainer (IAM-012): who can do what, and which grant or level decided it. */
export function PermissionExplainerPage({ client = explainClient }: { client?: ExplainClient }) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const id = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [lists, setLists] = useState<
    | { status: 'loading' }
    | {
        status: 'loaded';
        permissions: Record<string, string[]>;
        tracks: { id: number; key: string; name: string }[];
      }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Named[]>([]);
  const [person, setPerson] = useState('');
  const [track, setTrack] = useState('');
  const [ticket, setTicket] = useState('');
  const [permission, setPermission] = useState('');
  const [answer, setAnswer] = useState<{
    explanation: Explanation;
    who: string;
    what: string;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    Promise.all([client.catalogue(), client.tracks()]).then(
      ([permissions, tracks]) => {
        if (!live) return;
        setLists({ status: 'loaded', permissions, tracks });
        setPermission(Object.values(permissions).flat()[0] ?? '');
        setTrack(String(tracks[0]?.id ?? ''));
      },
      (error) => {
        if (!live || expired(error)) return;
        setLists({
          status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed',
        });
      },
    );
    return () => {
      live = false;
    };
  }, [client, expired, notAdmin]);

  useEffect(() => {
    if (query.trim() === '') {
      setPeople([]);
      setPerson('');
      return;
    }
    let live = true;
    client.findPeople(query.trim()).then(
      (found) => {
        if (!live) return;
        setPeople(found);
        setPerson(String(found[0]?.id ?? ''));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, query]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setAnswer(null);
    const key = ticket.trim();
    if (!permission || (!key && !track)) return;
    if (query.trim() && !person) {
      setProblem(t('admin.explain.noPerson'));
      return;
    }
    try {
      const explanation = await client.explain({
        permission,
        ...(person ? { userId: Number(person) } : {}),
        ...(key ? { ticket: key } : { trackId: Number(track) }),
      });
      setAnswer({
        explanation,
        who: people.find((p) => String(p.id) === person)?.name ?? t('admin.explain.anonymous'),
        what: t(`permission.${permission}` as MessageId),
      });
    } catch (error) {
      if (expired(error)) return;
      setProblem(
        error instanceof ApiError && error.status === 404
          ? t('admin.explain.notFound')
          : t('admin.explain.failed'),
      );
    }
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.explain.title')}
        {...(lists.status === 'forbidden'
          ? {}
          : { purpose: t('admin.explain.purpose'), about: t('admin.explain.about') })}
      />
      {lists.status === 'forbidden' && <p className="page-note">{t('admin.explain.forbidden')}</p>}
      {lists.status === 'loading' && <p className="page-note">{t('admin.explain.loading')}</p>}
      {lists.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.explain.loadFailed')}
        </p>
      )}
      {lists.status === 'loaded' && (
        <form
          className="form glass-card admin-panel"
          aria-label={t('admin.explain.formName')}
          onSubmit={(event) => void ask(event)}
        >
          <div className="form-field">
            <label htmlFor={`${id}-find`} className="form-label">
              {t('admin.permissions.findPerson')}
            </label>
            <input
              id={`${id}-find`}
              type="search"
              value={query}
              aria-describedby={`${id}-find-hint`}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p id={`${id}-find-hint`} className="form-hint">
              {t('admin.explain.personHint')}
            </p>
          </div>
          {query.trim() !== '' && (
            <div className="form-field">
              <label htmlFor={`${id}-person`} className="form-label">
                {t('admin.permissions.pickPerson')}
              </label>
              <select
                id={`${id}-person`}
                value={person}
                onChange={(e) => setPerson(e.target.value)}
              >
                {people.length === 0 && <option value="">{t('admin.explain.nobodyFound')}</option>}
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-field">
            <label htmlFor={`${id}-permission`} className="form-label">
              {t('admin.permissions.permission')}
            </label>
            <select
              id={`${id}-permission`}
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
            >
              {Object.entries(lists.permissions).map(([group, list]) => (
                <optgroup key={group} label={t(`permissionGroup.${group}` as MessageId)}>
                  {list.map((p) => (
                    <option key={p} value={p}>
                      {t(`permission.${p}` as MessageId)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-track`} className="form-label">
              {t('admin.explain.track')}
            </label>
            <select id={`${id}-track`} value={track} onChange={(e) => setTrack(e.target.value)}>
              {lists.tracks.map((x) => (
                <option key={x.id} value={x.id}>
                  {t('admin.explain.trackOption', { key: x.key, name: x.name })}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-ticket`} className="form-label">
              {t('admin.explain.ticket')}
            </label>
            <input
              id={`${id}-ticket`}
              value={ticket}
              aria-describedby={`${id}-ticket-hint`}
              onChange={(e) => setTicket(e.target.value)}
            />
            <p id={`${id}-ticket-hint`} className="form-hint">
              {t('admin.explain.ticketHint')}
            </p>
          </div>
          <button type="submit" className="button-primary">
            {t('admin.explain.ask')}
          </button>
        </form>
      )}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {answer && <Answer {...answer} />}
    </section>
  );
}

function Answer({
  explanation,
  who,
  what,
}: {
  explanation: Explanation;
  who: string;
  what: string;
}) {
  const t = useT();
  const id = useId();
  const { ticket } = explanation;
  const level = ticket?.visibilityLevel;
  return (
    <section aria-labelledby={id} className="glass-card admin-panel" aria-live="polite">
      <h2 id={id} className="section-title">
        {t(explanation.allowed ? 'admin.explain.yes' : 'admin.explain.no', { who, what })}
      </h2>
      {explanation.trackInTrash && <p className="page-note">{t('admin.explain.trash')}</p>}
      {explanation.trackArchived && <p className="page-note">{t('admin.explain.archived')}</p>}
      {explanation.reasons.length > 0 ? (
        <>
          <p className="page-note">{t('admin.explain.because')}</p>
          <ul className="admin-panel-list">
            {explanation.reasons.map((reason, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: administrator rights have no id, and the list never reorders.
              <li key={index}>{reasonText(t, reason)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="page-note">{t('admin.explain.noGrant')}</p>
      )}
      {!ticket && explanation.ticketLevel.length > 0 && (
        <>
          <p className="page-note">{t('admin.explain.perTicket')}</p>
          <ul className="admin-panel-list">
            {explanation.ticketLevel.map((g) => (
              <li key={g.grantId}>
                {t(`admin.permissions.grantee.${g.grantee}` as MessageId, {
                  name: g.fieldKey ?? '',
                })}
              </li>
            ))}
          </ul>
        </>
      )}
      {ticket && (
        <>
          <p className="page-note">
            {level
              ? t(level.member ? 'admin.explain.levelMember' : 'admin.explain.levelHidden', {
                  key: ticket.key,
                  level: level.name,
                })
              : t('admin.explain.noLevel', { key: ticket.key })}
          </p>
          {ticket.ticketGrants.length > 0 && (
            <ul className="admin-panel-list">
              {ticket.ticketGrants.map((g) => (
                <li key={`${g.grantee}-${g.field_key ?? ''}`}>
                  {t(`admin.permissions.grantee.${g.grantee}` as MessageId, {
                    name: g.field_key ?? '',
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

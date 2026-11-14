import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { tooManyAttemptsMessage } from '../session/errors';
import { CreateTracksBox } from './CreateTracksBox';
import {
  type Delivery,
  type InviteResult,
  type Named,
  parseAddresses,
  type TrackPeopleClient,
  type TrackRole,
} from './client';

export interface InviteDialogProps {
  track: { id: number; key: string };
  roles: TrackRole[];
  emailAvailable: boolean;
  /**
   * The person may make links to copy (T-053). Where the site sends email only site
   * administrators may, and everyone else's invitations go by email.
   */
  canCopyLinks?: boolean;
  /** The person may give the permission to create tracks with the role (IAM-033). */
  mayGrantCreateTracks?: boolean;
  client: TrackPeopleClient;
  onClose: () => void;
  /** After something was sent: the page reads its lists again. */
  onSent: () => void;
}

type Refusal = { error?: string; permission?: string };

const RESULT_LABELS: Record<InviteResult['status'], MessageId> = {
  invited: 'trackPeople.result.invited',
  already_invited: 'trackPeople.result.alreadyInvited',
  invalid: 'trackPeople.result.invalid',
  too_many: 'trackPeople.result.tooMany',
  added: 'trackPeople.result.added',
  already_holds: 'trackPeople.result.alreadyHolds',
};

/**
 * Inviting people into one track with one role (IAM-027): addresses typed or pasted, people
 * found by name, a role, and how the invitation travels. The answer reads the same for an
 * address that has an account and one that has not.
 */
export function InviteDialog({
  track,
  roles,
  emailAvailable,
  canCopyLinks = true,
  mayGrantCreateTracks = false,
  client,
  onClose,
  onSent,
}: InviteDialogProps) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const givable = roles.filter((r) => r.givable);
  const [addresses, setAddresses] = useState('');
  const [picked, setPicked] = useState<Named[]>([]);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Named[]>([]);
  const [role, setRole] = useState(() => {
    const quiet = givable.find((r) => !r.runsTrack) ?? givable[0];
    return String(quiet?.id ?? '');
  });
  const [delivery, setDelivery] = useState<Delivery>(emailAvailable ? 'email' : 'link');
  const [createTracks, setCreateTracks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResult[] | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client.findPeople(track.key, q).then(
        (people) => live && setFound(people),
        () => live && setFound([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, search, track.key]);

  const typed = parseAddresses(addresses);
  const offerCreateTracks =
    mayGrantCreateTracks && givable.some((r) => String(r.id) === role && r.runsTrack);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const answer = await client.invite(track.id, {
        addresses: typed,
        userIds: picked.map((p) => p.id),
        roleId: Number(role),
        delivery,
        ...(offerCreateTracks && createTracks ? { createTracks: true } : {}),
      });
      setResults(answer);
      onSent();
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as Refusal | null) : null;
      const code = body?.error ?? '';
      setProblem(
        body?.permission === 'create_local_tracks'
          ? t('trackPeople.problem.createTracks')
          : code === 'too_many_invitations'
            ? t('trackPeople.problem.tooMany')
            : code === 'email_not_set_up'
              ? t('trackPeople.emailOff')
              : code === 'email_invitations_only'
                ? t('trackPeople.linksByEmail')
                : error instanceof ApiError && error.status === 403
                  ? t('trackPeople.problem.forbidden')
                  : (tooManyAttemptsMessage(t, error) ?? t('trackPeople.problem.other')),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ticket-dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="ticket-dialog invite-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="ticket-section-title">
          {t('trackPeople.inviteTitle', { key: track.key })}
        </h2>
        {results ? (
          <>
            <ul className="people-sublist">
              {results.map((result) => (
                <li key={result.email ?? `user-${result.userId}`} className="invite-result">
                  <span>
                    {t(RESULT_LABELS[result.status], {
                      who: result.email ?? result.name ?? '',
                    })}
                    {result.sendFailed ? ` ${t('trackPeople.result.sendFailed')}` : ''}
                    {result.external ? ` ${t('trackPeople.result.external')}` : ''}
                  </span>
                  {result.link && (
                    <input
                      type="text"
                      readOnly
                      value={result.link}
                      aria-label={t('trackPeople.linkFor', { who: result.email ?? '' })}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                </li>
              ))}
            </ul>
            {results.some((r) => r.link) && (
              <p className="form-hint">{t('trackPeople.linkHint')}</p>
            )}
            <div className="form-actions">
              <button type="button" className="button-primary" onClick={onClose}>
                {t('trackPeople.done')}
              </button>
            </div>
          </>
        ) : (
          <form className="form" onSubmit={submit} aria-label={t('trackPeople.invite')}>
            {!emailAvailable && (
              <p role="status" className="page-note">
                {t('trackPeople.emailOff')}
              </p>
            )}
            <div className="form-field">
              <label htmlFor={`${id}-addresses`} className="form-label">
                {t('trackPeople.addresses')}
              </label>
              <textarea
                id={`${id}-addresses`}
                rows={3}
                value={addresses}
                aria-describedby={`${id}-addresses-hint`}
                onChange={(event) => setAddresses(event.target.value)}
              />
              <p id={`${id}-addresses-hint`} className="form-hint">
                {t('trackPeople.addressesHint')}
              </p>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-search`} className="form-label">
                {t('trackPeople.findByName')}
              </label>
              <input
                id={`${id}-search`}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {found.length > 0 && (
              <ul className="people-sublist">
                {found.map((person) => (
                  <li key={person.id}>
                    <span>{person.name}</span>
                    <button
                      type="button"
                      className="button-secondary people-action"
                      aria-label={t('trackPeople.pick', { name: person.name })}
                      onClick={() => {
                        setPicked((list) =>
                          list.some((p) => p.id === person.id) ? list : [...list, person],
                        );
                        setSearch('');
                      }}
                    >
                      {t('trackPeople.add')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {picked.length > 0 && (
              <ul className="people-sublist" aria-label={t('trackPeople.picked')}>
                {picked.map((person) => (
                  <li key={person.id}>
                    <span>{person.name}</span>
                    <button
                      type="button"
                      className="button-secondary people-action"
                      aria-label={t('trackPeople.unpick', { name: person.name })}
                      onClick={() => setPicked((list) => list.filter((p) => p.id !== person.id))}
                    >
                      {t('trackPeople.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="form-field">
              <label htmlFor={`${id}-role`} className="form-label">
                {t('trackPeople.role')}
              </label>
              <select
                id={`${id}-role`}
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {givable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            {offerCreateTracks && (
              <CreateTracksBox checked={createTracks} onChange={setCreateTracks} />
            )}
            {emailAvailable && !canCopyLinks && (
              <p className="form-hint">{t('trackPeople.linksByEmail')}</p>
            )}
            {emailAvailable && canCopyLinks && (
              <fieldset className="form-field invite-delivery">
                <legend className="form-label">{t('trackPeople.delivery')}</legend>
                <label>
                  <input
                    type="radio"
                    name={`${id}-delivery`}
                    checked={delivery === 'email'}
                    onChange={() => setDelivery('email')}
                  />{' '}
                  {t('trackPeople.delivery.email')}
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${id}-delivery`}
                    checked={delivery === 'link'}
                    onChange={() => setDelivery('link')}
                  />{' '}
                  {t('trackPeople.delivery.link')}
                </label>
              </fieldset>
            )}
            {problem && (
              <p role="alert" className="form-error">
                {problem}
              </p>
            )}
            <div className="form-actions">
              <button
                type="submit"
                className="button-primary"
                disabled={busy || !role || (typed.length === 0 && picked.length === 0)}
              >
                {t(delivery === 'email' ? 'trackPeople.send' : 'trackPeople.makeLinks')}
              </button>
              <button type="button" className="button-secondary" onClick={onClose}>
                {t('trackPeople.cancel')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

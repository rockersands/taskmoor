import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';
import type { GroupShare, GroupSharing, Named, TrackGroup, TrackGroupClient } from './client';

export interface ShareGroupDialogProps {
  /** Share the group as it is kept, or set a copy of it on someone (ADR-121). */
  mode: 'share' | 'setOn';
  group: TrackGroup;
  client: TrackGroupClient;
  onClose: () => void;
  /** Something changed that the page shows: who has it. */
  onChanged: () => void;
}

/**
 * Sharing a group, or setting it on someone (IAM-034). The owner picks a person and a role, or
 * none; each role says on how many of the group's tracks the owner may give it, and only there is
 * it given. Taking a share back removes only what the share gave.
 */
export function ShareGroupDialog({
  mode,
  group,
  client,
  onClose,
  onChanged,
}: ShareGroupDialogProps) {
  const t = useT();
  const id = useId();
  const [sharing, setSharing] = useState<GroupSharing | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Named[]>([]);
  const [person, setPerson] = useState<Named | null>(null);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const roleField = useRef<HTMLSelectElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const whoTitle = useRef<HTMLHeadingElement>(null);
  const whoList = useRef<HTMLUListElement>(null);
  /** Where focus goes once a person is chosen or let go: what they would do next. */
  const afterChoice = useRef<'role' | 'search' | null>(null);
  /** The row a take-back removed: focus goes to the row now in its place. */
  const afterTakeBack = useRef<number | null>(null);

  const [unreadable, setUnreadable] = useState(false);
  const load = useCallback(
    () => client.sharing(group.id).then(setSharing, () => setUnreadable(true)),
    [client, group.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // The control that held focus has just gone; focus moves to what comes next instead of the page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chosen person changes
  useEffect(() => {
    const to = afterChoice.current;
    afterChoice.current = null;
    if (to === 'role') roleField.current?.focus();
    if (to === 'search') searchField.current?.focus();
  }, [person]);

  useEffect(() => {
    const at = afterTakeBack.current;
    if (at === null || !sharing) return;
    afterTakeBack.current = null;
    const buttons = [...(whoList.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    (buttons[at] ?? buttons[at - 1] ?? whoTitle.current)?.focus();
  }, [sharing]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client.findPeople(q).then(
        (people) => live && setFound(people),
        () => live && setFound([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, search]);

  const refusal = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : undefined;
    if (code === 'already_shared') return t('trackGroups.problem.alreadyShared');
    if (code === 'person_inactive') return t('trackGroups.problem.inactive');
    if (code === 'last_track_admin') return t('trackGroups.lastAdmin');
    return t('trackGroups.changeFailed');
  };

  const chosenRole = sharing?.roles.find((r) => String(r.id) === role) ?? null;

  const submit = async () => {
    if (!person) return;
    setBusy(true);
    setProblem(null);
    setMessage('');
    try {
      const roleId = chosenRole?.id ?? null;
      const outcome =
        mode === 'share'
          ? await client.share(group.id, person.id, roleId)
          : await client.setOn(group.id, person.id, roleId);
      const values = {
        name: person.name,
        role: chosenRole?.name ?? '',
        given: outcome.given,
        total: outcome.tracks,
        held: outcome.alreadyHeld,
        notGivable: outcome.notGivable,
      };
      setMessage(
        mode === 'share'
          ? t(chosenRole ? 'trackGroups.sharedWithRole' : 'trackGroups.shared', values)
          : t(chosenRole ? 'trackGroups.setDoneWithRole' : 'trackGroups.setDone', values),
      );
      afterChoice.current = 'search';
      setPerson(null);
      setSearch('');
      setRole('');
      await load();
      onChanged();
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setBusy(false);
    }
  };

  const takeBack = async (share: GroupShare) => {
    setBusy(true);
    setProblem(null);
    setMessage('');
    try {
      await client.unshare(group.id, share.userId);
      setMessage(t('trackGroups.unshared', { name: share.name }));
      afterTakeBack.current = sharing?.shares.findIndex((s) => s.userId === share.userId) ?? 0;
      await load();
      onChanged();
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('trackGroups.closeDialog')}
      focusFirstField
      className="track-share-dialog"
    >
      <h2 id={`${id}-title`} className="section-title">
        {t(mode === 'share' ? 'trackGroups.share.title' : 'trackGroups.setOn.title', {
          name: group.name,
        })}
      </h2>
      <p className="page-note">
        {t(mode === 'share' ? 'trackGroups.share.intro' : 'trackGroups.setOn.intro')}
      </p>
      <p role="status" className="form-status">
        {message}
      </p>
      {(problem ?? unreadable) && (
        <p role="alert" className="form-error">
          {problem ?? t('trackGroups.changeFailed')}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {person ? (
          <p className="track-share-person">
            <span id={`${id}-chosen`}>{t('trackGroups.chosenPerson', { name: person.name })}</span>
            <button
              type="button"
              className="button-quiet"
              onClick={() => {
                afterChoice.current = 'search';
                setPerson(null);
              }}
            >
              {t('trackGroups.changePerson')}
            </button>
          </p>
        ) : (
          <>
            <div className="form-field">
              <label htmlFor={`${id}-person`} className="form-label">
                {t('trackGroups.person')}
              </label>
              <input
                ref={searchField}
                id={`${id}-person`}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {found.length > 0 && (
              <ul className="people-sublist">
                {found.map((p) => (
                  <li key={p.id}>
                    <span>{p.name}</span>
                    <button
                      type="button"
                      className="button-secondary people-action"
                      aria-label={t('trackGroups.choose', { name: p.name })}
                      onClick={() => {
                        afterChoice.current = 'role';
                        setPerson(p);
                      }}
                    >
                      {t('trackGroups.chooseShort')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="form-field">
          <label htmlFor={`${id}-role`} className="form-label">
            {t('trackGroups.role')}
          </label>
          <select
            ref={roleField}
            id={`${id}-role`}
            value={role}
            {...(person ? { 'aria-describedby': `${id}-chosen` } : {})}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="">{t('trackGroups.noRole')}</option>
            {sharing?.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {t('trackGroups.roleOption', {
                  role: r.name,
                  count: r.givableOn,
                  total: sharing.trackCount,
                })}
              </option>
            ))}
          </select>
        </div>
        {sharing && sharing.roles.length === 0 && (
          <p className="page-note">{t('trackGroups.noRolesToGive')}</p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={!person || busy}>
            {t(mode === 'share' ? 'trackGroups.share.do' : 'trackGroups.setOn.do')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('trackGroups.done')}
          </button>
        </div>
      </form>
      {mode === 'share' && sharing && (
        <section aria-labelledby={`${id}-who`} className="track-share-list">
          <h3 id={`${id}-who`} ref={whoTitle} tabIndex={-1} className="section-title">
            {t('trackGroups.sharedWithList')}
          </h3>
          {sharing.shares.length === 0 ? (
            <p className="page-note">{t('trackGroups.notShared')}</p>
          ) : (
            <ul ref={whoList} className="people-sublist">
              {sharing.shares.map((share) => (
                <li key={share.userId}>
                  <span>
                    {share.role
                      ? t('trackGroups.shareRow', {
                          name: share.name,
                          role: share.role.name,
                          count: share.holds,
                        })
                      : t('trackGroups.shareRowNoRole', { name: share.name })}
                    {!share.active && (
                      <span className="track-share-inactive">{t('trackGroups.inactive')}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="button-secondary people-action"
                    disabled={busy}
                    aria-label={t('trackGroups.unshare', { name: share.name })}
                    onClick={() => void takeBack(share)}
                  >
                    {t('trackGroups.unshareShort')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </ModalDialog>
  );
}

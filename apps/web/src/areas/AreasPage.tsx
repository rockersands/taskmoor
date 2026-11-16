import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { PersonPicker } from '../tickets/PersonPicker';
import {
  AREA_RULES,
  type Area,
  type AreaClient,
  type AreaDeletion,
  type AreaRule,
  type AreaTrack,
  areaClient,
  areaQuery,
  type Named,
  ticketsInUse,
} from './client';

export interface AreasPageProps {
  /** The track whose areas these are (#/tracks/KEY/areas). */
  trackKey: string;
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: AreaClient;
}

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded'; track: AreaTrack; areas: Area[]; mayManage: boolean };

/** What the rule of an area says on its row. */
const RULE_LINE: Record<AreaRule, MessageId> = {
  area_owner: 'areas.rule.area_owner',
  track_owner: 'areas.rule.track_owner',
  unassigned: 'areas.rule.unassigned',
};
/** The rule's choice in the form. */
const RULE_CHOICE: Record<AreaRule, MessageId> = {
  area_owner: 'areas.form.rule.area_owner',
  track_owner: 'areas.form.rule.track_owner',
  unassigned: 'areas.form.rule.unassigned',
};

/** The id of an area's row button that keeps the focus after a change moved the row. */
const buttonId = (page: string, areaId: number, which: 'change' | 'archive' | 'restore') =>
  `${page}-area-${areaId}-${which}`;

/**
 * A track's areas (CORE-015) at #/tracks/KEY/areas, under the track's tab bar with no tab of its
 * own, as its Ticket templates are; the Summary and the track's page under Tracks you run lead
 * here. Everyone who sees the track reads which parts its work has, who owns each and who gets a
 * part's new tickets. Its administrators, and site and configuration administrators, add, change,
 * archive, restore and delete them here (T-320): Delete, in the danger colour, asks first (D13),
 * and for an area tickets are in it then asks where they go, another area or none.
 */
export function AreasPage({ trackKey, client = areaClient }: AreasPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const titleId = `${id}-title`;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<State>({ status: 'loading' });
  // A new area's form opens from the New button (D11); a saved one's from its row's Change.
  const creating = useNewForm();
  const [editing, setEditing] = useState<Area | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * What takes the focus once it is drawn: a row's button after the row moved to the other list,
   * its Change after the form went, or the heading after the row went. It waits for the list read
   * again, so it never lands on the row as it was.
   */
  const [focusTo, setFocusTo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const track = await client.track(trackKey);
      const [areas, mayManage] = await Promise.all([
        client.list(track.id),
        // Not knowing only means no way to change them is offered; the server decides anyway.
        client.mayManage(track.id).catch(() => false),
      ]);
      setState({ status: 'loaded', track, areas, mayManage });
    } catch (error) {
      if (!expired(error)) setState({ status: 'failed' });
    }
  }, [client, trackKey, expired]);
  useEffect(() => {
    void load();
  }, [load]);

  /** The list read again after a change, the track and what the reader may do staying as read. */
  const reread = useCallback(
    async (track: AreaTrack) => {
      try {
        const areas = await client.list(track.id);
        setState((s) => (s.status === 'loaded' ? { ...s, areas } : s));
      } catch (error) {
        if (!expired(error)) setState({ status: 'failed' });
      }
    },
    [client, expired],
  );

  useEffect(() => {
    if (focusTo === null) return;
    const target = document.getElementById(focusTo);
    if (!target) return;
    setFocusTo(null);
    target.focus();
  });

  const refusalOf = (error: unknown): string => {
    if (!(error instanceof ApiError)) return t('areas.problem.other');
    const body = error.body as { error?: string; detail?: string; limit?: number } | null;
    switch (body?.error) {
      case 'name_taken':
        return t('areas.problem.nameTaken');
      case 'guardrail_exceeded':
        return t('areas.problem.limit', { limit: body.limit ?? 0 });
      case 'track_archived':
        return t('areas.readOnlyArchived');
      case 'not_found':
      case 'already_archived':
      case 'not_archived':
        return t('areas.problem.changed');
      case 'invalid_request':
        if (body.detail === 'ownerId') return t('areas.problem.owner');
        if (body.detail === 'ownerTeamId') return t('areas.problem.team');
        if (body.detail === 'replacementId') return t('areas.problem.replacement');
        return t('areas.problem.other');
    }
    if (error.status === 403) return t('areas.readOnly');
    return t('areas.problem.other');
  };

  // A track's areas sit under its tab bar: titled like its other pages, the track named above the
  // title (D26), the line under it saying what the page covers (TR-27).
  const titled = (
    <PageHeader
      titleId={titleId}
      titleRef={titleRef}
      title={t('areas.title')}
      eyebrow={state.status === 'loaded' ? state.track.name : trackKey}
      purpose={t('areas.purpose')}
      about={t('areas.about')}
      {...(state.status === 'loaded' && state.mayManage
        ? {
            // In the one place every page that adds things has it (D11, AD-18).
            actions: (
              <NewButton
                label={t('areas.new')}
                open={creating.open}
                onToggle={() => {
                  setMessage('');
                  setProblem(null);
                  setEditing(null);
                  creating.toggle();
                }}
                ref={creating.button}
              />
            ),
          }
        : {})}
    />
  );

  if (state.status !== 'loaded') {
    return (
      <section aria-labelledby={titleId} className="page admin-page people-page">
        {titled}
        {state.status === 'loading' ? (
          <p className="page-note">{t('areas.loading')}</p>
        ) : (
          <p role="alert" className="form-error">
            {t('areas.failed')}
          </p>
        )}
      </section>
    );
  }

  const { track, areas, mayManage } = state;
  const active = areas.filter((a) => !a.archived);
  const archived = areas.filter((a) => a.archived);

  const said = (text: string, focus: string | null) => {
    setProblem(null);
    setMessage(text);
    if (focus !== null) setFocusTo(focus);
    return reread(track);
  };

  /** Archive or restore; the row moves to the other list, and its other button keeps the focus. */
  const toggleArchive = async (area: Area) => {
    setMessage('');
    try {
      if (area.archived) await client.restore(area.id);
      else await client.archive(area.id);
    } catch (error) {
      if (expired(error)) return;
      setProblem(refusalOf(error));
      await reread(track);
      return;
    }
    await said(
      t(area.archived ? 'areas.restoredDone' : 'areas.archivedDone', { name: area.name }),
      buttonId(id, area.id, area.archived ? 'archive' : 'restore'),
    );
  };

  /**
   * Deletes, asked first by DangerAction. An area tickets are in answers how many (409 `in_use`):
   * the row then asks where they go, and the count comes back here instead of a refusal.
   */
  const remove = async (area: Area, deletion?: AreaDeletion): Promise<number | null> => {
    setMessage('');
    try {
      await client.remove(area.id, deletion);
    } catch (error) {
      const count = deletion ? null : ticketsInUse(error);
      if (count !== null) {
        setProblem(null);
        return count;
      }
      if (!expired(error)) {
        setProblem(refusalOf(error));
        // The area that was to take the tickets may be gone: the choices are read again.
        if (deletion) void reread(track);
      }
      throw error;
    }
    const to = deletion && 'replacementId' in deletion ? deletion.replacementId : null;
    const into = areas.find((a) => a.id === to)?.name;
    // The row is gone: the page's heading takes the focus.
    await said(
      into
        ? t('areas.deletedMoved', { name: area.name, to: into })
        : deletion
          ? t('areas.deletedRemoved', { name: area.name })
          : t('areas.deleted', { name: area.name }),
      titleId,
    );
    return null;
  };

  const row = (area: Area) => (
    <AreaRow
      key={area.id}
      page={id}
      area={area}
      trackKey={track.key}
      others={active.filter((a) => a.id !== area.id)}
      mayManage={mayManage}
      onChange={() => {
        setMessage('');
        setProblem(null);
        // One form at a time: a new area's gives way.
        if (creating.open) creating.toggle();
        setEditing(area);
      }}
      onToggleArchive={() => toggleArchive(area)}
      onRemove={(deletion) => remove(area, deletion)}
    />
  );

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      {titled}
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {!mayManage && (
        <p className="page-note">
          {track.archived ? t('areas.readOnlyArchived') : t('areas.readOnly')}
        </p>
      )}
      {mayManage && (creating.open || editing) && (
        <AreaForm
          key={editing?.id ?? 'new'}
          client={client}
          track={track}
          area={editing}
          refusalOf={refusalOf}
          // Someone may have changed the list meanwhile: it is read again behind the form.
          onRefused={() => void reread(track)}
          onCancel={() => {
            if (editing) {
              setFocusTo(buttonId(id, editing.id, 'change'));
              setEditing(null);
            } else creating.close();
          }}
          onSaved={(saved) => {
            if (editing) setEditing(null);
            else creating.close();
            void said(
              t(editing ? 'areas.saved' : 'areas.created', { name: saved.name }),
              editing ? buttonId(id, saved.id, 'change') : null,
            );
          }}
        />
      )}
      {active.length === 0 ? (
        <EmptyState title={t('areas.none')}>
          {mayManage ? t('empty.areas.body') : t('empty.areas.bodyRead')}
        </EmptyState>
      ) : (
        <ul className="people-list" aria-label={t('areas.listLabel', { key: track.key })}>
          {active.map(row)}
        </ul>
      )}
      {archived.length > 0 && (
        <section aria-labelledby={`${id}-archived`} className="glass-card people-card">
          <h2 id={`${id}-archived`} className="facts-title">
            {t('areas.archivedTitle')}
          </h2>
          <p className="page-note">{t('areas.archivedNote')}</p>
          <ul className="people-list">{archived.map(row)}</ul>
        </section>
      )}
    </section>
  );
}

/** One area: what it is, who owns it and its rule, and for those who may, its actions. */
function AreaRow({
  page,
  area,
  trackKey,
  others,
  mayManage,
  onChange,
  onToggleArchive,
  onRemove,
}: {
  page: string;
  area: Area;
  trackKey: string;
  /** The track's other areas that are not archived: where its tickets may go. */
  others: Area[];
  mayManage: boolean;
  onChange: () => void;
  onToggleArchive: () => Promise<void>;
  onRemove: (deletion?: AreaDeletion) => Promise<number | null>;
}) {
  const t = useT();
  const id = useId();
  const item = useRef<HTMLLIElement>(null);
  const choice = useRef<HTMLSelectElement>(null);
  /** How many tickets are in it, once the server said so on Delete. */
  const [inUse, setInUse] = useState<number | null>(null);
  const [target, setTarget] = useState('none');
  const [busy, setBusy] = useState(false);
  // In use: the question closes and the choice of where its tickets go takes the focus.
  useEffect(() => {
    if (inUse !== null) choice.current?.focus();
  }, [inUse]);
  // An area chosen to take the tickets that is no longer offered is no longer chosen.
  useEffect(() => {
    if (target !== 'none' && !others.some((o) => String(o.id) === target)) setTarget('none');
  }, [others, target]);
  // A second press while one runs sends nothing more; the button stays focusable throughout.
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    await onToggleArchive();
    setBusy(false);
  };
  const ask = async () => {
    const count = await onRemove();
    if (count !== null) {
      setTarget('none');
      setInUse(count);
    }
  };
  const searchHref = routeHref(
    `#/search?${new URLSearchParams({ q: areaQuery(trackKey, area.name) }).toString()}`,
  );

  return (
    <li ref={item} className="people-item">
      <div className="people-main">
        <p className="people-name">{area.name}</p>
        {area.description && <p className="people-meta">{area.description}</p>}
        <p className="people-meta">
          {area.owner ? t('areas.owner', { name: area.owner.name }) : t('areas.ownerUnset')}
        </p>
        {area.ownerTeam && (
          <p className="people-meta">{t('areas.ownerTeam', { name: area.ownerTeam.name })}</p>
        )}
        <p className="people-meta">{t(RULE_LINE[area.defaultAssignee])}</p>
      </div>
      {mayManage && (
        <div className="people-actions">
          {!area.archived && (
            <button
              id={buttonId(page, area.id, 'change')}
              type="button"
              className="button-secondary people-action"
              aria-label={t('areas.changeOf', { name: area.name })}
              onClick={onChange}
            >
              {t('areas.change')}
            </button>
          )}
          <button
            id={buttonId(page, area.id, area.archived ? 'restore' : 'archive')}
            type="button"
            className="button-secondary people-action"
            aria-label={t(area.archived ? 'areas.restoreOf' : 'areas.archiveOf', {
              name: area.name,
            })}
            aria-disabled={busy || undefined}
            onClick={() => void toggle()}
          >
            {t(area.archived ? 'areas.restore' : 'areas.archive')}
          </button>
          {/* Asks first, saying what will happen (D13); an area tickets are in asks where they go. */}
          <DangerAction
            label={t('areas.delete')}
            name={t('areas.deleteOf', { name: area.name })}
            outcome={t('areas.confirmDelete', { name: area.name })}
            confirmLabel={t('areas.deleteOf', { name: area.name })}
            onConfirm={ask}
          />
        </div>
      )}
      {mayManage && inUse !== null && (
        <div className="people-panel">
          <form
            className="people-inline"
            aria-label={t('areas.whereTicketsGo', { name: area.name })}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const deletion: AreaDeletion =
                target === 'none' ? { removeFromTickets: true } : { replacementId: Number(target) };
              setBusy(true);
              onRemove(deletion).then(
                () => setBusy(false),
                // Refused: the page says why above; the choice stays to try again or cancel.
                () => setBusy(false),
              );
            }}
          >
            <p className="people-meta">
              {t('areas.inUse', { count: inUse, name: area.name })}{' '}
              <a href={searchHref}>{t('areas.inUseSearch')}</a>
            </p>
            <div className="form-field">
              <label htmlFor={`${id}-to`} className="form-label">
                {t('areas.moveTo')}
              </label>
              <select
                ref={choice}
                id={`${id}-to`}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="none">{t('areas.moveNone', { name: area.name })}</option>
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="button-danger people-action"
              aria-disabled={busy || undefined}
            >
              {t('areas.deleteOf', { name: area.name })}
            </button>
            <button
              type="button"
              className="button-secondary people-action"
              onClick={() => {
                setInUse(null);
                // Back to the row's own Delete.
                item.current?.querySelector<HTMLButtonElement>('.button-danger-quiet')?.focus();
              }}
            >
              {t('danger.cancel')}
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

/** The form for a new area, or for changing one: above the list, one at a time. */
function AreaForm({
  client,
  track,
  area,
  refusalOf,
  onRefused,
  onCancel,
  onSaved,
}: {
  client: AreaClient;
  track: AreaTrack;
  /** The area being changed; none for a new one. */
  area: Area | null;
  refusalOf: (error: unknown) => string;
  onRefused: () => void;
  onCancel: () => void;
  onSaved: (saved: Area) => void;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(area?.name ?? '');
  const [description, setDescription] = useState(area?.description ?? '');
  const [owner, setOwner] = useState<Named | null>(area?.owner ?? null);
  const [team, setTeam] = useState<Named | null>(area?.ownerTeam ?? null);
  const [rule, setRule] = useState<AreaRule>(area?.defaultAssignee ?? 'unassigned');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The form may open far above the row that opened it: its first field takes the focus.
  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setProblem(null);
    const input = {
      name: trimmed,
      description,
      ownerId: owner?.id ?? null,
      ownerTeamId: team?.id ?? null,
      defaultAssignee: rule,
    };
    let saved: Area;
    try {
      saved = area ? await client.update(area.id, input) : await client.create(track.id, input);
    } catch (error) {
      setBusy(false);
      if (expired(error)) return;
      setProblem(refusalOf(error));
      onRefused();
      return;
    }
    onSaved(saved);
  };

  return (
    <form
      className="glass-card people-card people-form"
      aria-label={area ? t('areas.changeOf', { name: area.name }) : t('areas.new')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      noValidate
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('areas.form.name')}
        </label>
        <input
          ref={nameInput}
          id={`${id}-name`}
          type="text"
          required
          aria-required="true"
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-description`} className="form-label">
          {t('areas.form.description')}
        </label>
        <textarea
          id={`${id}-description`}
          rows={3}
          maxLength={10_000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="form-field">
        <PersonPicker
          label={t('areas.form.owner')}
          hint={t('areas.form.ownerHint')}
          search={(typed) => client.people(track.key, typed)}
          chosen={owner ? [owner] : []}
          removeLabel={(who) => t('areas.form.removeOwner', { name: who })}
          onChange={(people) => setOwner(people[0] ?? null)}
        />
      </div>
      <div className="form-field">
        <PersonPicker
          kind="teams"
          label={t('areas.form.team')}
          hint={t('areas.form.teamHint')}
          search={(typed) => client.teams(typed)}
          chosen={team ? [team] : []}
          removeLabel={(which) => t('areas.form.removeTeam', { name: which })}
          onChange={(teams) => setTeam(teams[0] ?? null)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-rule`} className="form-label">
          {t('areas.form.rule')}
        </label>
        <select
          id={`${id}-rule`}
          value={rule}
          aria-describedby={`${id}-rule-hint`}
          onChange={(e) => setRule(e.target.value as AreaRule)}
        >
          {AREA_RULES.map((choice) => (
            <option key={choice} value={choice}>
              {t(RULE_CHOICE[choice])}
            </option>
          ))}
        </select>
        <p id={`${id}-rule-hint`} className="form-hint">
          {rule === 'area_owner' && !owner ? t('areas.form.ruleNoOwner') : t('areas.form.ruleHint')}
        </p>
      </div>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy || name.trim() === ''}>
          {t('areas.form.save')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('areas.form.cancel')}
        </button>
      </div>
    </form>
  );
}

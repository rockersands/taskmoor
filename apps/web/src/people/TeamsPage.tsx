import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import type { User } from './client';
import { type TeamDetail, type TeamSummary, type TeamsClient, teamsClient } from './teamsClient';

export interface TeamsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: TeamsClient;
}

/**
 * Teams (M1-123, CORE-027), for site administrators: make, rename and delete teams, describe
 * them, choose their members and their lead. Boards, areas and Team fields name a team, and a
 * rename shows everywhere. A team gives no permissions: groups do.
 */
export function TeamsPage({ client = teamsClient }: TeamsPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; teams: TeamSummary[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [open, setOpen] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', teams: await client.teams('') });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const refusal = useCallback(
    (error: unknown) => {
      const code =
        error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
      if (code === 'name_taken') return t('admin.teams.problem.nameTaken');
      return t('admin.teams.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    void load();
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.teams.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('settings.teamsHint'), about: t('admin.teams.intro') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.teams.forbidden')}</p>
      ) : (
        <>
          <AddTeam
            client={client}
            onAdded={(made) => {
              said(t('admin.teams.added', { name: made.name }));
              setOpen(made.id);
            }}
            onProblem={(error) => setProblem(refusal(error))}
          />
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('admin.teams.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.teams.failed')}
            </p>
          )}
          {state.status === 'loaded' &&
            (state.teams.length === 0 ? (
              <EmptyState title={t('admin.teams.none')}>{t('empty.teams.body')}</EmptyState>
            ) : (
              <ul className="people-list">
                {state.teams.map((team) => (
                  <li key={team.id} className="people-item people-group">
                    <div className="people-main">
                      <p className="people-name">{team.name}</p>
                      <p className="people-meta">
                        {t('admin.teams.members', { count: team.memberCount })}
                        {' · '}
                        {team.lead
                          ? t('admin.teams.ledBy', { name: team.lead.name })
                          : t('admin.teams.noLead')}
                        {team.description ? ` · ${team.description}` : ''}
                      </p>
                    </div>
                    <div className="people-actions">
                      <button
                        type="button"
                        className="button-secondary people-action"
                        aria-expanded={open === team.id}
                        aria-label={t('admin.teams.manageOf', { name: team.name })}
                        onClick={() => setOpen(open === team.id ? null : team.id)}
                      >
                        {t('admin.teams.manage')}
                      </button>
                    </div>
                    {open === team.id && (
                      <TeamPanel
                        id={team.id}
                        client={client}
                        onChanged={said}
                        onDeleted={(name) => {
                          setOpen(null);
                          said(t('admin.teams.deleted', { name }));
                        }}
                        onProblem={(error) => setProblem(refusal(error))}
                      />
                    )}
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </section>
  );
}

function AddTeam({
  client,
  onAdded,
  onProblem,
}: {
  client: TeamsClient;
  onAdded: (made: TeamSummary) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      className="people-form"
      aria-label={t('admin.teams.add')}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        client.createTeam({ name: wanted, description: description.trim() }).then((made) => {
          onAdded(made);
          setName('');
          setDescription('');
        }, onProblem);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.teams.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          maxLength={255}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-description`} className="form-label">
          {t('admin.teams.description')}
        </label>
        <input
          id={`${id}-description`}
          type="text"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.teams.add')}
        </button>
      </div>
    </form>
  );
}

function TeamPanel({
  id,
  client,
  onChanged,
  onDeleted,
  onProblem,
}: {
  id: number;
  client: TeamsClient;
  onChanged: (message: string) => void;
  onDeleted: (name: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const formId = useId();
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lead, setLead] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<User[]>([]);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const read = await client.team(id);
      setDetail(read);
      setName(read.team.name);
      setDescription(read.team.description);
      setLead(read.team.lead ? String(read.team.lead.id) : '');
    } catch (error) {
      onProblem(error);
    }
  }, [client, id, onProblem]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per team
  useEffect(() => {
    void load();
  }, [id]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      client.people(q).then(
        (people) => live && setFound(people.slice(0, 8)),
        () => {},
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, search]);

  const run = async (work: () => Promise<void>, message: string) => {
    try {
      await work();
      await load();
      onChanged(message);
    } catch (error) {
      onProblem(error);
    }
  };

  if (!detail) return <p className="page-note people-panel">{t('admin.teams.loading')}</p>;
  const current = detail.team.name;
  const memberIds = new Set(detail.members.map((m) => m.id));
  // The lead is chosen among the members; one who left the team stays choosable until changed.
  const leads = [...detail.members];
  if (detail.team.lead && !memberIds.has(detail.team.lead.id)) {
    leads.push({ ...detail.team.lead, active: true });
  }

  return (
    <div className="people-panel">
      <form
        className="people-form"
        aria-label={t('admin.teams.editOf', { name: current })}
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = name.trim();
          if (!wanted) return;
          void run(
            async () => {
              await client.updateTeam(id, {
                name: wanted,
                description: description.trim(),
                leadId: lead === '' ? null : Number(lead),
              });
            },
            t('admin.teams.saved', { name: wanted }),
          );
        }}
      >
        <div className="form-field">
          <label htmlFor={`${formId}-name`} className="form-label">
            {t('admin.teams.name')}
          </label>
          <input
            id={`${formId}-name`}
            type="text"
            required
            maxLength={255}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${formId}-description`} className="form-label">
            {t('admin.teams.description')}
          </label>
          <input
            id={`${formId}-description`}
            type="text"
            maxLength={2000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${formId}-lead`} className="form-label">
            {t('admin.teams.lead')}
          </label>
          <select
            id={`${formId}-lead`}
            value={lead}
            aria-describedby={`${formId}-lead-hint`}
            onChange={(event) => setLead(event.target.value)}
          >
            <option value="">{t('admin.teams.noLead')}</option>
            {leads.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <p id={`${formId}-lead-hint`} className="form-hint">
            {t('admin.teams.leadHint')}
          </p>
        </div>
        <div className="form-actions">
          <button type="submit" className="button-primary">
            {t('admin.teams.save')}
          </button>
        </div>
      </form>

      <h2 className="facts-title">{t('admin.teams.membersOf', { name: current })}</h2>
      {detail.members.length === 0 ? (
        <EmptyState compact title={t('admin.teams.noMembers')} />
      ) : (
        <ul className="people-sublist">
          {detail.members.map((m) => (
            <li key={m.id}>
              <span>{m.active ? m.name : t('admin.teams.inactive', { name: m.name })}</span>
              <button
                type="button"
                className="button-secondary people-action"
                aria-label={t('admin.teams.removeMember', { person: m.name, team: current })}
                onClick={() =>
                  void run(
                    () => client.removeTeamMember(id, m.id),
                    t('admin.teams.memberRemoved', { person: m.name, team: current }),
                  )
                }
              >
                {t('admin.teams.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-field">
        <label htmlFor={`${formId}-search`} className="form-label">
          {t('admin.teams.addPerson')}
        </label>
        <input
          id={`${formId}-search`}
          type="search"
          value={search}
          aria-describedby={`${formId}-search-hint`}
          onChange={(event) => setSearch(event.target.value)}
        />
        <p id={`${formId}-search-hint`} className="form-hint">
          {t('admin.teams.addPersonHint')}
        </p>
      </div>
      {found.length > 0 && (
        <ul className="people-sublist">
          {found
            .filter((u) => !memberIds.has(u.id))
            .map((u) => (
              <li key={u.id}>
                <span>
                  {u.name} · {u.email}
                </span>
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-label={t('admin.teams.addMember', { person: u.name, team: current })}
                  onClick={() =>
                    void run(
                      async () => {
                        await client.addTeamMember(id, u.id);
                        setSearch('');
                      },
                      t('admin.teams.memberAdded', { person: u.name, team: current }),
                    )
                  }
                >
                  {t('admin.teams.addShort')}
                </button>
              </li>
            ))}
        </ul>
      )}

      <div className="form-actions">
        {confirming ? (
          <>
            <span className="people-confirm">
              {t('admin.teams.confirmDelete', { name: current })}
            </span>
            <button
              type="button"
              className="button-danger"
              onClick={() => void client.deleteTeam(id).then(() => onDeleted(current), onProblem)}
            >
              {t('admin.teams.confirmYes')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setConfirming(false)}>
              {t('admin.teams.confirmNo')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button-secondary"
            aria-label={t('admin.teams.deleteOf', { name: current })}
            onClick={() => setConfirming(true)}
          >
            {t('admin.teams.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

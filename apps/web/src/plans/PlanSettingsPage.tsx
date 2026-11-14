import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { navigate } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import type {
  CapacityUnit,
  LinkTypeOption,
  Plan,
  PlanClient,
  PlanPeriod,
  PlanShare,
  PlanSourceInput,
  SourceOptions,
} from './client';
import { SourcePicker } from './SourcePicker';
import { type TeamOption, TeamPicker } from './TeamPicker';

type Visibility = 'private' | 'any_user' | 'custom';

/** What a save would clear: every capacity (a new unit), or the single periods' (new periods). */
type Clearing = 'unit' | 'period';

/** The page's choice of who sees a plan; other shares are kept as they are. */
function visibilityOf(shares: readonly PlanShare[]): Visibility {
  if (shares.length === 0) return 'private';
  if (shares.length === 1 && shares[0]?.scope === 'any_user') return 'any_user';
  return 'custom';
}

const inputOf = (plan: Plan): PlanSourceInput[] =>
  plan.sources.map((s) =>
    s.kind === 'track'
      ? { kind: 'track', trackId: s.id }
      : { kind: 'savedSearch', savedSearchId: s.id },
  );

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/** Whether two settings make the same periods: an anchor moved by whole periods changes none. */
function samePeriods(a: PlanPeriod, b: PlanPeriod): boolean {
  if (a.kind === 'month' || b.kind === 'month') return a.kind === b.kind;
  return a.weeks === b.weeks && (dayNumber(a.anchor) - dayNumber(b.anchor)) % (a.weeks * 7) === 0;
}

/** The choices of the periods' select: every 1 to 6 weeks, or each calendar month. */
const PERIOD_CHOICES = ['1', '2', '3', '4', '5', '6', 'month'] as const;

export interface PlanSettingsPageProps {
  plan: Plan;
  client: PlanClient;
  onSaved: () => void;
}

/** A link type that reads "A blocks B": always counted as a dependency, never chosen (PLN-013). */
const isBlocking = (l: { outward: string }) => l.outward.trim().toLowerCase() === 'blocks';

/**
 * A plan's settings (PLN-001), for its owner and site administrators: its name, description,
 * sources and who sees it, and deleting it. The sources hidden from the editor stay as they are:
 * nobody removes what they cannot see. Sharing needs "Share dashboards and saved searches".
 * Teams and capacity (PLN-005): the site teams the plan plans with, the unit work and capacity
 * are counted in and its periods. A new unit clears every capacity set, and new periods the
 * capacity set for single periods, so Save asks first, in its own place, as DangerAction does
 * (D13): what goes, the save by name beside Cancel, the focus on Cancel and back on Save.
 */
export function PlanSettingsPage({ plan, client, onSaved }: PlanSettingsPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [sources, setSources] = useState<PlanSourceInput[]>(() => inputOf(plan));
  const [visibility, setVisibility] = useState<Visibility>(() => visibilityOf(plan.shares));
  const [options, setOptions] = useState<SourceOptions | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [teams, setTeams] = useState<number[]>(() => plan.teams.map((x) => x.id));
  const [teamOptions, setTeamOptions] = useState<TeamOption[] | null>(null);
  const [teamsFailed, setTeamsFailed] = useState(false);
  const [unit, setUnit] = useState<CapacityUnit>(plan.capacityUnit);
  const [periodChoice, setPeriodChoice] = useState<string>(
    plan.period.kind === 'month' ? 'month' : String(plan.period.weeks),
  );
  const [anchor, setAnchor] = useState(plan.period.kind === 'weeks' ? plan.period.anchor : '');
  // Dependency options (PLN-013): link types counted beside blocking ones, and the sprint flag.
  // A chosen type an administrator has since made a blocking one is always counted: it is neither
  // offered nor sent again, which the plan's update would refuse (`always_counted`).
  const [linkTypes, setLinkTypes] = useState<number[]>(
    () => plan.dependencies?.linkTypes.filter((l) => !isBlocking(l)).map((l) => l.id) ?? [],
  );
  const [sameSprint, setSameSprint] = useState(plan.dependencies?.sameSprint ?? false);
  const [linkOptions, setLinkOptions] = useState<LinkTypeOption[] | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  const [asking, setAsking] = useState<Clearing | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // Read once per plan, not again for each version saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per plan, not per version
  useEffect(() => {
    let live = true;
    client.sourceOptions().then(
      (o) => {
        if (!live) return;
        // A source the plan has that the directory did not list still shows, ticked.
        const tracks = [...o.tracks];
        const searches = [...o.savedSearches];
        for (const s of plan.sources) {
          if (s.kind === 'track' && !tracks.some((x) => x.id === s.id)) {
            tracks.push({ id: s.id, key: s.key, name: s.name });
          }
          if (s.kind === 'savedSearch' && !searches.some((x) => x.id === s.id)) {
            searches.push({ id: s.id, name: s.name });
          }
        }
        setOptions({ tracks, savedSearches: searches });
      },
      () => live && setOptionsFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, plan.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per plan, not per version
  useEffect(() => {
    let live = true;
    client.teamOptions().then(
      (list) => {
        if (!live) return;
        // A team the plan has that the list did not give still shows, ticked.
        const all: TeamOption[] = [...list];
        for (const x of plan.teams) {
          if (!all.some((o) => o.id === x.id)) all.push({ ...x, memberCount: null });
        }
        setTeamOptions(all);
      },
      () => live && setTeamsFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, plan.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per plan, not per version
  useEffect(() => {
    let live = true;
    client.linkTypeOptions().then(
      (list) => {
        if (!live) return;
        // Blocking links are always counted, so they are not offered.
        const offered = list.filter((l) => !isBlocking(l));
        const blocking = new Set(list.filter(isBlocking).map((l) => l.id));
        for (const l of plan.dependencies?.linkTypes ?? []) {
          if (!blocking.has(l.id) && !isBlocking(l) && !offered.some((o) => o.id === l.id)) {
            offered.push(l);
          }
        }
        setLinkTypes((chosen) => chosen.filter((id) => !blocking.has(id)));
        setLinkOptions(offered);
      },
      () => live && setLinksFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, plan.id]);

  const period: PlanPeriod | null =
    periodChoice === 'month'
      ? { kind: 'month' }
      : anchor
        ? { kind: 'weeks', weeks: Number(periodChoice), anchor }
        : null;

  // What a save would clear, asked in place of Save first (D13): every capacity, or the
  // capacity set for single periods.
  const clears: Clearing | null = !period
    ? null
    : unit !== plan.capacityUnit
      ? 'unit'
      : !samePeriods(period, plan.period)
        ? 'period'
        : null;

  const closeQuestion = (focusSave: boolean) => {
    returnFocus.current = focusSave;
    setAsking(null);
  };

  useEffect(() => {
    if (asking) {
      cancelButton.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      saveButton.current?.focus();
    }
  }, [asking]);

  const submit = () => {
    if (!name.trim() || !period) return;
    if (clears) setAsking(clears);
    else void save();
  };

  const save = async () => {
    if (!name.trim() || !period) return;
    setBusy(true);
    setProblem(null);
    setStatus('');
    const saved = await client.update(plan.id, {
      name: name.trim(),
      description,
      sources,
      ...(visibility === 'custom'
        ? {}
        : { shares: visibility === 'private' ? [] : [{ scope: 'any_user' as const }] }),
      teams,
      capacityUnit: unit,
      period,
      dependencies: { linkTypeIds: linkTypes, sameSprint },
      version: plan.version,
    });
    setBusy(false);
    // Answered: the question goes, and the focus waits on Save, the result beside it.
    if (asking) closeQuestion(true);
    if (saved.ok) {
      setStatus(t('plans.settings.saved'));
      onSaved();
      return;
    }
    setProblem(
      saved.error === 'version_conflict'
        ? t('plans.settings.conflict')
        : saved.error === 'forbidden'
          ? t('plans.settings.mayNotShare')
          : Object.keys(saved.fields).some((k) => k.startsWith('teams'))
            ? t('plans.settings.teamGone')
            : Object.keys(saved.fields).some((k) => k.startsWith('dependencies'))
              ? t('plans.settings.linkTypeGone')
              : Object.values(saved.fields).includes('not_found')
                ? t('plans.create.sourceGone')
                : t('plans.settings.failed'),
    );
  };

  // Asked first by DangerAction (D13); a refusal keeps the question open, the reason above it.
  const remove = async () => {
    setProblem(null);
    try {
      await client.remove(plan.id);
    } catch (error) {
      setProblem(t('plans.settings.deleteFailed'));
      throw error;
    }
    navigate('#/plans');
  };

  return (
    <form
      className="glass-card plan-settings"
      aria-label={t('plans.section.settings')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      // A change to the settings makes the question about the old ones moot.
      onChange={() => {
        if (asking) closeQuestion(false);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`}>{t('plans.name')}</label>
        <input
          id={`${id}-name`}
          value={name}
          maxLength={255}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-description`}>{t('plans.description')}</label>
        <textarea
          id={`${id}-description`}
          value={description}
          maxLength={4000}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      {optionsFailed ? (
        <p className="board-problem" role="alert">
          {t('plans.sources.failed')}
        </p>
      ) : (
        <SourcePicker options={options} value={sources} onChange={setSources} />
      )}
      {plan.hiddenSources > 0 && (
        <p className="board-hint">
          {t('plans.settings.hiddenKept', { count: plan.hiddenSources })}
        </p>
      )}
      <div className="form-field">
        <label htmlFor={`${id}-visibility`}>{t('plans.visibility')}</label>
        <select
          id={`${id}-visibility`}
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as Visibility)}
        >
          <option value="private">{t('plans.visibility.private')}</option>
          <option value="any_user">{t('plans.visibility.any_user')}</option>
          {visibilityOf(plan.shares) === 'custom' && (
            <option value="custom">{t('plans.visibility.custom')}</option>
          )}
        </select>
      </div>
      <fieldset className="plan-capacity-settings">
        <legend>{t('plans.settings.capacity')}</legend>
        {teamsFailed ? (
          <p className="board-problem" role="alert">
            {t('plans.settings.teamsFailed')}
          </p>
        ) : (
          <TeamPicker options={teamOptions} value={teams} onChange={setTeams} />
        )}
        <div className="plan-capacity-settings-row">
          <label className="form-field" htmlFor={`${id}-unit`}>
            <span className="form-label">{t('plans.settings.unit')}</span>
            <select
              id={`${id}-unit`}
              value={unit}
              onChange={(event) => setUnit(event.target.value as CapacityUnit)}
            >
              <option value="points">{t('plans.settings.unit.points')}</option>
              <option value="hours">{t('plans.settings.unit.hours')}</option>
            </select>
          </label>
          <label className="form-field" htmlFor={`${id}-period`}>
            <span className="form-label">{t('plans.settings.period')}</span>
            <select
              id={`${id}-period`}
              value={periodChoice}
              onChange={(event) => setPeriodChoice(event.target.value)}
            >
              {PERIOD_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice === 'month'
                    ? t('plans.settings.period.month')
                    : t('plans.settings.period.weeks', { count: Number(choice) })}
                </option>
              ))}
            </select>
          </label>
          {periodChoice !== 'month' && (
            <div className="form-field">
              <label className="form-label" htmlFor={`${id}-anchor`}>
                {t('plans.settings.anchor')}
              </label>
              <input
                id={`${id}-anchor`}
                type="date"
                required
                value={anchor}
                aria-describedby={anchor ? `${id}-anchor-day` : undefined}
                onChange={(event) => setAnchor(event.target.value)}
              />
              {/* The browser writes the box's date its own way; the page says it in its own (PL-41). */}
              {anchor && (
                <span className="board-hint" id={`${id}-anchor-day`}>
                  {t('plans.settings.anchorDay', {
                    date: intl.formatDate(new Date(`${anchor}T00:00:00Z`), {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'UTC',
                    }),
                  })}
                </span>
              )}
            </div>
          )}
        </div>
        <p className="board-hint">{t('plans.settings.capacityHint')}</p>
      </fieldset>
      <fieldset className="plan-dependency-settings">
        <legend>{t('plans.settings.dependencies')}</legend>
        <p className="board-hint">{t('plans.settings.dependenciesHint')}</p>
        {linksFailed ? (
          <p className="board-problem" role="alert">
            {t('plans.settings.linkTypesFailed')}
          </p>
        ) : linkOptions === null ? (
          <p className="board-hint">{t('reports.loading')}</p>
        ) : linkOptions.length === 0 ? (
          <p className="board-hint">{t('plans.settings.noLinkTypes')}</p>
        ) : (
          <ul className="plan-link-types">
            {linkOptions.map((l) => (
              <li key={l.id} className="form-field form-field-inline">
                <input
                  id={`${id}-link-${l.id}`}
                  type="checkbox"
                  checked={linkTypes.includes(l.id)}
                  onChange={(event) =>
                    setLinkTypes((list) =>
                      event.target.checked
                        ? [...list, l.id].sort((a, b) => a - b)
                        : list.filter((x) => x !== l.id),
                    )
                  }
                />
                <label htmlFor={`${id}-link-${l.id}`}>
                  {t('plans.settings.linkType', { name: l.name, phrase: l.outward })}
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="form-field form-field-inline">
          <input
            id={`${id}-same-sprint`}
            type="checkbox"
            checked={sameSprint}
            onChange={(event) => setSameSprint(event.target.checked)}
          />
          <label htmlFor={`${id}-same-sprint`}>{t('plans.settings.sameSprint')}</label>
        </div>
      </fieldset>
      <p className="board-hint" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="form-actions">
        {asking ? (
          // biome-ignore lint/a11y/useSemanticElements: a question and its two answers, not a set of fields
          <div
            className="danger-confirm"
            role="group"
            aria-labelledby={`${id}-clears`}
            aria-busy={busy || undefined}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              if (!busy) closeQuestion(true);
            }}
          >
            <p id={`${id}-clears`} className="danger-confirm-outcome">
              {t(asking === 'unit' ? 'plans.settings.confirmUnit' : 'plans.settings.confirmPeriod')}
            </p>
            <div className="danger-confirm-actions">
              <button
                type="button"
                className="button-danger"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void save();
                }}
              >
                {t(
                  asking === 'unit'
                    ? 'plans.settings.confirmUnitAction'
                    : 'plans.settings.confirmPeriodAction',
                )}
              </button>
              <button
                ref={cancelButton}
                type="button"
                className="button-secondary"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) closeQuestion(true);
                }}
              >
                {t('danger.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={saveButton}
            type="submit"
            className="button-primary"
            disabled={busy || !name.trim() || !period}
          >
            {t('plans.settings.save')}
          </button>
        )}
        {/* A danger, and it asks first, saying what goes (D13). */}
        <DangerAction
          label={t('plans.settings.delete')}
          outcome={t('plans.settings.confirmDelete', { name: plan.name })}
          confirmLabel={t('plans.settings.deleteNamed', { name: plan.name })}
          onConfirm={remove}
        />
      </div>
    </form>
  );
}

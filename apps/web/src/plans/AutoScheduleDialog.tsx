import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { ModalDialog } from '../shell/ModalDialog';
import type { PlanPeriod } from './client';
import type {
  ScenarioClient,
  ScenarioList,
  ScenarioRow,
  ScheduleReadiness,
  ScheduleRequest,
  ScheduleResult,
  ScheduleRun,
} from './scenarioClient';

/** The run's defaults when the server names none: ADR-122 stage 7's limits. */
const DEFAULT_PERIODS = 6;
const MAX_PERIODS = 12;
const MAX_LEFT_OUT = 20;
const MAX_QUERY = 2_000;

/** The choices kept in this browser, per plan: a convenience, never needed (ADR-122 stage 7). */
export interface Choices {
  periods: number;
  keepInProgress: boolean;
  keepInSprint: boolean;
  keepQuery: string;
  typeIds: number[];
  releaseIds: number[];
  leaveQuery: string;
}

const DEFAULTS: Choices = {
  periods: DEFAULT_PERIODS,
  keepInProgress: true,
  keepInSprint: true,
  keepQuery: '',
  typeIds: [],
  releaseIds: [],
  leaveQuery: '',
};

const storageKey = (planId: number) => `taskmoor.autoSchedule.${planId}`;

const numbers = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [];

/** The last choices used for this plan in this browser, or the defaults. */
export function readChoices(planId: number): Choices {
  try {
    const raw = window.localStorage.getItem(storageKey(planId));
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Record<keyof Choices, unknown>>;
    const periods = Number(v.periods);
    return {
      periods:
        Number.isInteger(periods) && periods >= 1 && periods <= MAX_PERIODS
          ? periods
          : DEFAULT_PERIODS,
      keepInProgress: v.keepInProgress !== false,
      keepInSprint: v.keepInSprint !== false,
      keepQuery: typeof v.keepQuery === 'string' ? v.keepQuery.slice(0, MAX_QUERY) : '',
      typeIds: numbers(v.typeIds).slice(0, MAX_LEFT_OUT),
      releaseIds: numbers(v.releaseIds).slice(0, MAX_LEFT_OUT),
      leaveQuery: typeof v.leaveQuery === 'string' ? v.leaveQuery.slice(0, MAX_QUERY) : '',
    };
  } catch {
    return DEFAULTS;
  }
}

function saveChoices(planId: number, choices: Choices) {
  try {
    window.localStorage.setItem(storageKey(planId), JSON.stringify(choices));
  } catch {
    // Storage can be blocked; the dialog starts from the defaults next time.
  }
}

/** The words of a refused run. */
const REFUSED: Record<string, MessageId> = {
  too_many_scenarios: 'schedule.dialog.refused.tooManyScenarios',
  apply_in_progress: 'schedule.dialog.refused.applying',
  too_many_to_schedule: 'schedule.dialog.refused.tooManyToSchedule',
  plan_too_large: 'schedule.dialog.refused.planTooLarge',
  too_many_drafts: 'schedule.dialog.refused.tooManyDrafts',
  forbidden: 'schedule.dialog.refused.forbidden',
  not_found: 'schedule.dialog.refused.gone',
  query_timeout: 'schedule.dialog.refused.timeout',
  invalid_query: 'schedule.dialog.refused.query',
  unsupported_query: 'schedule.dialog.refused.query',
  invalid_fields: 'schedule.dialog.refused.invalid',
};

/** Why a run was refused, in words, with the limit and count it names. */
export function scheduleRefusal(t: Translate, refused: Extract<ScheduleRun, { ok: false }>) {
  const id = REFUSED[refused.code];
  if (!id) return t('schedule.dialog.refused.other');
  return t(id, { limit: refused.limit ?? 0, count: refused.count ?? 0 });
}

/** What a run was asked, for "Its choices": the choices, and the names of what it left out. */
export interface ScheduleAsked extends Choices {
  from: string;
  types: string[];
  releases: string[];
}

export interface AutoScheduleDialogProps {
  planId: number;
  client: Pick<ScenarioClient, 'readiness' | 'schedule'>;
  /** The plan's scenarios. */
  list: ScenarioList;
  /** The scenario open, or null in Live. */
  active: ScenarioRow | null;
  /** The plan's periods, to say how long the run looks ahead. */
  period: PlanPeriod;
  /** The person's own today, `YYYY-MM-DD`: the first day by default. */
  today: string;
  /** The address of the plan's Capacity tab, where capacity is set. */
  capacityHref: string;
  /**
   * The run answered: the page opens its scenario's changes with the result. `asked` is what the
   * run was asked, with the names of the ticket types and releases it left out.
   */
  onDone: (result: ScheduleResult, asked: ScheduleAsked) => void;
  onClose: () => void;
}

/**
 * Auto-schedule (T-089f; PLN-004; ADR-122 stage 7): proposes start and due days for the plan's open
 * tickets as draft changes in a scenario, a new one or the one open. It reads readiness first, so
 * what would stop tickets being placed shows before the run: which teams have capacity, the unit
 * and where sizes come from, and the tickets without an estimate, an assignee or a team. When no
 * team has capacity, Run is off with the reason beside it. The choices (what to keep, what to
 * leave out, from when and how far) start from the last ones used in this browser. While it runs,
 * Run says so and the dialog stays until the run answers. A sheet on a phone.
 */
export function AutoScheduleDialog({
  planId,
  client,
  list,
  active,
  period,
  today,
  capacityHref,
  onDone,
  onClose,
}: AutoScheduleDialogProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [first] = useState(() => readChoices(planId));
  const shortDay = (iso: string) =>
    intl.formatDate(new Date(`${iso}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

  const full = list.scenarios.length >= list.limits.scenarios;
  const [target, setTarget] = useState<'new' | 'this'>(
    full && active && !active.applying ? 'this' : 'new',
  );
  const [name, setName] = useState(() =>
    t('schedule.dialog.defaultName', { day: shortDay(today) }),
  );
  const [copyFrom, setCopyFrom] = useState(active ? String(active.id) : '');
  const [keepInProgress, setKeepInProgress] = useState(first.keepInProgress);
  const [keepInSprint, setKeepInSprint] = useState(first.keepInSprint);
  const [keepQuery, setKeepQuery] = useState(first.keepQuery);
  const [typeIds, setTypeIds] = useState(first.typeIds);
  const [releaseIds, setReleaseIds] = useState(first.releaseIds);
  const [leaveQuery, setLeaveQuery] = useState(first.leaveQuery);
  const [from, setFrom] = useState(today);
  const [periods, setPeriods] = useState(first.periods);
  // The last readiness read, with the choices it answers; `readiness` is it only while those are
  // still the choices, so a run never starts on an answer for other ones.
  const [read, setRead] = useState<{ key: string; value: ScheduleReadiness } | null>(null);
  const [readinessFailed, setReadinessFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const into = target === 'this' && active ? active.id : copyFrom ? Number(copyFrom) : undefined;
  const day = from || today;
  const readKey = JSON.stringify([planId, into ?? null, day, periods]);
  const readiness = read?.key === readKey ? read.value : null;
  // What the leave-out lists offer and the limits hold: the last answer, whatever it was asked.
  const known = read?.value ?? null;
  // Readiness for the run as chosen: its periods, and the scenario's earlier proposals.
  const asked = useRef(0);
  const reader = useRef(client);
  reader.current = client;
  useEffect(() => {
    const call = ++asked.current;
    const key = JSON.stringify([planId, into ?? null, day, periods]);
    setReadinessFailed(false);
    reader.current
      .readiness(planId, { ...(into === undefined ? {} : { scenario: into }), from: day, periods })
      .then((r) => {
        if (call === asked.current) setRead({ key, value: r });
      })
      .catch(() => {
        if (call === asked.current) setReadinessFailed(true);
      });
  }, [planId, into, day, periods]);

  // After a refused run, the field it names takes the focus; else Run keeps it.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    document.getElementById(target)?.focus();
  });

  const limits = known?.limits;
  const maxPeriods = limits?.periods ?? MAX_PERIODS;
  const maxLeftOut = limits?.leftOut ?? MAX_LEFT_OUT;
  const maxQuery = limits?.query ?? MAX_QUERY;

  // Where the result can go.
  const newOff = full ? t('schedule.dialog.newFull', { count: list.limits.scenarios }) : null;
  const thisOff = active?.applying
    ? t('schedule.dialog.thisApplying', { name: active.name })
    : null;

  // What stops Run, said beside it.
  const teams = readiness?.teams ?? [];
  const withCapacity = teams.filter((x) => x.withCapacity);
  const noSizes = readiness?.unit === 'points' && readiness.pointsField === null;
  const blocked =
    !readiness && !readinessFailed
      ? t('schedule.dialog.off.reading')
      : readiness && !readiness.editable
        ? t('schedule.dialog.off.notEditor')
        : (target === 'new' && newOff) || (target === 'this' && thisOff)
          ? t('schedule.dialog.off.nowhere')
          : readiness && teams.length === 0
            ? t('schedule.dialog.off.noTeams')
            : readiness && withCapacity.length === 0
              ? t('schedule.dialog.off.noCapacity')
              : noSizes
                ? t('schedule.dialog.off.noSizes')
                : null;

  // Only what the dialog offers counts and is sent: a type or release remembered from before
  // that the plan no longer offers is neither left out unseen nor kept for next time.
  const offeredTypes = typeIds.filter((one) => known?.types?.some((o) => o.id === one));
  const offeredReleases = releaseIds.filter((one) => known?.releases?.some((o) => o.id === one));

  const run = async () => {
    if (running || blocked) return;
    const trimmed = name.trim();
    if (target === 'new' && trimmed === '') {
      focusNext.current = `${id}-name`;
      setFields({ name: 'required' });
      setProblem(null);
      return;
    }
    const keepText = keepQuery.trim();
    const leaveText = leaveQuery.trim();
    const leftTypes = offeredTypes;
    const leftReleases = offeredReleases;
    const body: ScheduleRequest = {
      into:
        target === 'this' && active
          ? { scenarioId: active.id }
          : { newScenario: { name: trimmed, ...(copyFrom ? { from: Number(copyFrom) } : {}) } },
      from: day,
      periods,
      leaveOut: {
        typeIds: leftTypes,
        releaseIds: leftReleases,
        ...(leaveText ? { query: leaveText } : {}),
      },
      keep: {
        inProgress: keepInProgress,
        inActiveSprint: keepInSprint,
        ...(keepText ? { query: keepText } : {}),
      },
    };
    setRunning(true);
    setProblem(null);
    setFields({});
    const answer = await client.schedule(planId, body).catch(() => null);
    setRunning(false);
    if (!answer) {
      setProblem(t('schedule.dialog.refused.other'));
      return;
    }
    if (!answer.ok) {
      const named = Object.fromEntries(
        Object.entries(answer.fields).map(([k, v]) => [
          k === 'leaveOut.query' || k === 'keep.query' ? k : k.endsWith('name') ? 'name' : k,
          v,
        ]),
      );
      const field = (
        [
          ['name', `${id}-name`],
          ['keep.query', `${id}-keep-query`],
          ['leaveOut.query', `${id}-leave-query`],
        ] as const
      ).find(([k]) => k in named);
      focusNext.current = field ? field[1] : null;
      setFields(named);
      if (answer.code !== 'invalid_fields' || !field) setProblem(scheduleRefusal(t, answer));
      return;
    }
    // An answer naming no scenario cannot be opened: the scenario went as the run finished.
    if (!answer.value.scenario) {
      setProblem(t('schedule.dialog.refused.gone'));
      return;
    }
    const chosen: Choices = {
      periods,
      keepInProgress,
      keepInSprint,
      keepQuery,
      typeIds: leftTypes,
      releaseIds: leftReleases,
      leaveQuery,
    };
    saveChoices(planId, chosen);
    const nameOf = (options: { id: number; name: string }[] | undefined, ids: number[]) =>
      ids.flatMap((one) => options?.find((o) => o.id === one)?.name ?? []);
    onDone(answer.value, {
      ...chosen,
      from: day,
      types: nameOf(known?.types, leftTypes),
      releases: nameOf(known?.releases, leftReleases),
    });
  };

  const close = () => {
    // The dialog closes only once a run has answered.
    if (!running) onClose();
  };

  const toggle = (ids: number[], one: number, on: boolean) =>
    on ? [...ids, one].sort((a, b) => a - b) : ids.filter((x) => x !== one);

  const queryError = (field: 'keep.query' | 'leaveOut.query') =>
    fields[field] ? t('schedule.dialog.queryError') : null;
  const nameError =
    fields.name === 'required'
      ? t('scenario.new.nameRequired')
      : fields.name
        ? t('schedule.dialog.nameError')
        : null;

  const span = readiness?.periods.length
    ? {
        count: readiness.periods.length,
        start: shortDay(readiness.periods[0]?.start ?? day),
        end: shortDay(readiness.periods.at(-1)?.end ?? day),
      }
    : null;
  const proposals = readiness?.scenario?.proposals ?? 0;
  const drafts = readiness?.scenario?.drafts ?? 0;

  return (
    <ModalDialog
      onClose={close}
      labelledBy={`${id}-title`}
      closeLabel={t('scenario.cancel')}
      className="auto-schedule-dialog"
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <h2 id={`${id}-title`}>{t('schedule.dialog.title')}</h2>
        <p className="board-hint">{t('schedule.dialog.intro')}</p>

        <section className="auto-schedule-readiness" aria-labelledby={`${id}-ready`}>
          <h3 id={`${id}-ready`} className="visually-hidden">
            {t('schedule.dialog.readiness')}
          </h3>
          {readinessFailed && (
            <p className="board-problem" role="alert">
              {t('schedule.dialog.readinessFailed')}
            </p>
          )}
          {!readiness && !readinessFailed && (
            <p className="board-hint">{t('schedule.dialog.reading')}</p>
          )}
          {readiness && (
            <>
              <p>
                {teams.length === 0
                  ? t('schedule.dialog.teams.none')
                  : withCapacity.length === 0
                    ? t('schedule.dialog.teams.noCapacity', { count: teams.length })
                    : t('schedule.dialog.teams.with', {
                        count: withCapacity.length,
                        teams: intl.formatList(
                          withCapacity.map((x) => x.name),
                          { type: 'conjunction' },
                        ),
                      })}
                {withCapacity.length > 0 &&
                  withCapacity.length < teams.length &&
                  ` ${t('schedule.dialog.teams.without', {
                    count: teams.length - withCapacity.length,
                    teams: intl.formatList(
                      teams.filter((x) => !x.withCapacity).map((x) => x.name),
                      { type: 'conjunction' },
                    ),
                  })}`}{' '}
                <a href={routeHref(capacityHref)} onClick={close}>
                  {t('schedule.dialog.capacityLink')}
                </a>
              </p>
              <p>
                {readiness.unit === 'hours'
                  ? t('schedule.dialog.unit.hours')
                  : readiness.pointsField
                    ? t('schedule.dialog.unit.points', { field: readiness.pointsField.name })
                    : t('schedule.dialog.unit.noPoints')}
              </p>
              <p>
                {t('schedule.dialog.tickets', { count: readiness.tickets.open })}
                {readiness.people.withCapacity + readiness.people.without > 0 &&
                  ` ${t('schedule.dialog.people', {
                    count: readiness.people.withCapacity,
                    without: readiness.people.without,
                  })}`}
              </p>
              {readiness.tickets.unestimated +
                readiness.tickets.unassigned +
                readiness.tickets.noTeam >
                0 && (
                <p>
                  {t('schedule.dialog.notPlacedAhead', {
                    list: intl.formatList(
                      [
                        readiness.tickets.unestimated > 0 &&
                          t('schedule.dialog.unestimated', {
                            count: readiness.tickets.unestimated,
                          }),
                        readiness.tickets.unassigned > 0 &&
                          t('schedule.dialog.unassigned', { count: readiness.tickets.unassigned }),
                        readiness.tickets.noTeam > 0 &&
                          t('schedule.dialog.noTeam', { count: readiness.tickets.noTeam }),
                      ].filter((x): x is string => typeof x === 'string'),
                      { type: 'conjunction' },
                    ),
                  })}
                </p>
              )}
            </>
          )}
        </section>

        <fieldset>
          <legend>{t('schedule.dialog.where')}</legend>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-new`}
              type="radio"
              name={`${id}-where`}
              checked={target === 'new'}
              disabled={newOff !== null}
              aria-describedby={newOff ? `${id}-new-off` : undefined}
              onChange={() => setTarget('new')}
            />
            <label htmlFor={`${id}-new`}>{t('schedule.dialog.new')}</label>
          </div>
          {newOff && (
            <p className="board-hint" id={`${id}-new-off`}>
              {newOff}
            </p>
          )}
          {target === 'new' && !newOff && (
            <>
              <label className="form-field" htmlFor={`${id}-name`}>
                <span className="form-label">{t('scenario.name')}</span>
                <input
                  id={`${id}-name`}
                  value={name}
                  maxLength={100}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? `${id}-name-error` : undefined}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {nameError && (
                <p className="board-problem" id={`${id}-name-error`}>
                  {nameError}
                </p>
              )}
              {list.scenarios.length > 0 ? (
                <label className="form-field" htmlFor={`${id}-from-scenario`}>
                  <span className="form-label">{t('scenario.new.from')}</span>
                  <select
                    id={`${id}-from-scenario`}
                    value={copyFrom}
                    onChange={(event) => setCopyFrom(event.target.value)}
                  >
                    <option value="">{t('scenario.new.empty')}</option>
                    {list.scenarios.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {t('scenario.new.copyOf', { name: s.name, count: s.drafts })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="board-hint">{t('schedule.dialog.becomesMain')}</p>
              )}
            </>
          )}
          {active && (
            <>
              <div className="form-field form-field-inline">
                <input
                  id={`${id}-this`}
                  type="radio"
                  name={`${id}-where`}
                  checked={target === 'this'}
                  disabled={thisOff !== null}
                  aria-describedby={thisOff ? `${id}-this-off` : undefined}
                  onChange={() => setTarget('this')}
                />
                <label htmlFor={`${id}-this`}>
                  {t('schedule.dialog.this', { name: active.name })}
                </label>
              </div>
              {thisOff && (
                <p className="board-hint" id={`${id}-this-off`}>
                  {thisOff}
                </p>
              )}
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>{t('schedule.dialog.what')}</legend>
          <p className="board-hint">{t('schedule.dialog.closedNever')}</p>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-keep-progress`}
              type="checkbox"
              checked={keepInProgress}
              onChange={(event) => setKeepInProgress(event.target.checked)}
            />
            <label htmlFor={`${id}-keep-progress`}>{t('schedule.dialog.keepInProgress')}</label>
          </div>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-keep-sprint`}
              type="checkbox"
              checked={keepInSprint}
              onChange={(event) => setKeepInSprint(event.target.checked)}
            />
            <label htmlFor={`${id}-keep-sprint`}>{t('schedule.dialog.keepInSprint')}</label>
          </div>
          <QueryField
            id={`${id}-keep-query`}
            label={t('schedule.dialog.keepQuery')}
            hint={t('schedule.dialog.keepQueryHint')}
            value={keepQuery}
            max={maxQuery}
            error={queryError('keep.query')}
            onChange={setKeepQuery}
          />
          <ChoiceList
            id={`${id}-types`}
            legend={t('schedule.dialog.leaveTypes')}
            empty={t('schedule.dialog.leaveTypesNone')}
            options={known?.types ?? []}
            chosen={offeredTypes}
            max={maxLeftOut}
            onToggle={(one, on) => setTypeIds((ids) => toggle(ids, one, on))}
          />
          <ChoiceList
            id={`${id}-releases`}
            legend={t('schedule.dialog.leaveReleases')}
            empty={t('schedule.dialog.leaveReleasesNone')}
            options={(known?.releases ?? []).map((r) => ({
              id: r.id,
              name: r.date
                ? t('schedule.dialog.releaseOn', { name: r.name, day: shortDay(r.date) })
                : r.name,
            }))}
            chosen={offeredReleases}
            max={maxLeftOut}
            onToggle={(one, on) => setReleaseIds((ids) => toggle(ids, one, on))}
          />
          <QueryField
            id={`${id}-leave-query`}
            label={t('schedule.dialog.leaveQuery')}
            hint={t('schedule.dialog.leaveQueryHint')}
            value={leaveQuery}
            max={maxQuery}
            error={queryError('leaveOut.query')}
            onChange={setLeaveQuery}
          />
        </fieldset>

        <fieldset>
          <legend>{t('schedule.dialog.when')}</legend>
          <div className="plan-capacity-settings-row">
            <label className="form-field" htmlFor={`${id}-from`}>
              <span className="form-label">{t('schedule.dialog.from')}</span>
              <input
                id={`${id}-from`}
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className="form-field" htmlFor={`${id}-periods`}>
              <span className="form-label">{t('schedule.dialog.lookAhead')}</span>
              <select
                id={`${id}-periods`}
                value={String(periods)}
                aria-describedby={span ? `${id}-span` : undefined}
                onChange={(event) => setPeriods(Number(event.target.value))}
              >
                {Array.from({ length: maxPeriods }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>
                    {period.kind === 'month'
                      ? t('schedule.dialog.months', { count: n })
                      : t('schedule.dialog.periods', { count: n })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {span && (
            <p className="board-hint" id={`${id}-span`}>
              {period.kind === 'month'
                ? t('schedule.dialog.spanMonths', span)
                : t('schedule.dialog.spanWeeks', { ...span, weeks: period.weeks })}
            </p>
          )}
        </fieldset>

        {target === 'this' && active && proposals > 0 && (
          <p className="board-hint">{t('schedule.dialog.rerun', { count: proposals, drafts })}</p>
        )}
        <p className="board-hint">{t('schedule.dialog.changesNothing')}</p>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <p className="visually-hidden" role="status">
          {running
            ? readiness
              ? t('schedule.dialog.running', { count: readiness.tickets.open })
              : t('schedule.dialog.runningAll')
            : ''}
        </p>
        <div className="form-actions">
          {/* While it runs, Run stays focusable (aria-disabled): a disabled button would drop the
              focus out of the dialog. */}
          <button
            type="submit"
            className="button-primary"
            disabled={blocked !== null}
            aria-disabled={running || undefined}
            aria-describedby={blocked ? `${id}-off` : undefined}
          >
            {running ? t('schedule.dialog.runningButton') : t('schedule.dialog.run')}
          </button>
          <button type="button" className="button-secondary" disabled={running} onClick={close}>
            {t('scenario.cancel')}
          </button>
          {blocked && (
            <p className="board-hint" id={`${id}-off`}>
              {blocked}
            </p>
          )}
        </div>
      </form>
    </ModalDialog>
  );
}

/** A query condition, with what it does and, when the server could not read it, why. */
function QueryField({
  id,
  label,
  hint,
  value,
  max,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  max: number;
  error: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="form-field">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        maxLength={max}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <p className="board-problem" id={`${id}-error`}>
          {error}
        </p>
      )}
      <p className="form-hint" id={`${id}-hint`}>
        {hint}
      </p>
    </div>
  );
}

/** Choices to leave out, as check boxes: at most `max` chosen; none to offer is said. */
function ChoiceList({
  id,
  legend,
  empty,
  options,
  chosen,
  max,
  onToggle,
}: {
  id: string;
  legend: string;
  empty: string;
  options: { id: number; name: string }[];
  chosen: number[];
  max: number;
  onToggle: (id: number, on: boolean) => void;
}) {
  const t = useT();
  const atMost = chosen.length >= max;
  return (
    <fieldset className="auto-schedule-choices">
      <legend>{legend}</legend>
      {options.length === 0 ? (
        <p className="board-hint">{empty}</p>
      ) : (
        <ul className="popover-list thin-scroll">
          {options.map((o) => {
            const on = chosen.includes(o.id);
            return (
              <li key={o.id} className="form-field form-field-inline">
                <input
                  id={`${id}-${o.id}`}
                  type="checkbox"
                  checked={on}
                  disabled={!on && atMost}
                  onChange={(event) => onToggle(o.id, event.target.checked)}
                />
                <label htmlFor={`${id}-${o.id}`}>{o.name}</label>
              </li>
            );
          })}
        </ul>
      )}
      {atMost && <p className="board-hint">{t('schedule.dialog.leaveMax', { count: max })}</p>}
    </fieldset>
  );
}

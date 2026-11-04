import { useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { type ListClient, listClient } from '../list/client';
import { navigate, routeHref, useRoute } from '../routing/router';
import { type SearchClient, searchClient } from '../search/client';
import { useMotionOnChange } from '../shell/motion';
import { typeName } from '../shell/seededNames';
import {
  PLAN_GROUPS,
  PLAN_SECTIONS,
  type PlanGroup,
  type PlanSection,
  type PlanView,
  planHref,
  readView,
} from './address';
import { type Plan, type PlanChoices, type PlanClient, planClient } from './client';
import { PlanCalendarPage } from './PlanCalendarPage';
import { PlanCapacityPage } from './PlanCapacityPage';
import { PlanListPage } from './PlanListPage';
import { PlanSettingsPage } from './PlanSettingsPage';
import { PlanSummaryPage } from './PlanSummaryPage';
import { PlanTimelinePage } from './PlanTimelinePage';

export interface PlanPageProps {
  id: number;
  section: PlanSection;
  client?: PlanClient;
  search?: SearchClient;
  list?: ListClient;
  /** Today, for the Timeline and the Calendar. */
  now?: () => Date;
}

const GROUP_LABELS: Record<PlanGroup | 'none', MessageId> = {
  none: 'plans.group.none',
  track: 'plans.group.track',
  assignee: 'plans.group.assignee',
  status: 'plans.group.status',
  type: 'plans.group.type',
  priority: 'plans.group.priority',
};
const STAGES = [
  { id: 'new', label: 'search.stage.new' },
  { id: 'active', label: 'search.stage.active' },
  { id: 'closed', label: 'search.stage.closed' },
] as const satisfies readonly { id: string; label: MessageId }[];

/**
 * One Multi-track plan (T-088; PLN-001, PLN-012; ADR-122): its name and owner, a tab bar of its
 * Summary, Timeline, List, Calendar and Capacity (PLN-005, PLN-009), and Settings for those who
 * may change it, and the
 * filters every view shares, one value each, with the grouping of the Timeline and the List. The
 * filters and the grouping live in the page's address, so a link opens the same view and the
 * browser's back button undoes a change. The plan shows only what the person may see; the page
 * says when some of its sources are hidden from them or no longer run.
 */
export function PlanPage({
  id,
  section,
  client = planClient,
  search = searchClient,
  list = listClient,
  now = () => new Date(),
}: PlanPageProps) {
  const t = useT();
  const titleId = useId();
  const route = useRoute();
  const view = readView(route);
  const viewKey = planHref(id, 'summary', view);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<'missing' | 'filter' | 'failed' | null>(null);
  const [choices, setChoices] = useState<PlanChoices | null>(null);
  const [version, setVersion] = useState(0);
  const body = useMotionOnChange<HTMLDivElement>('motion-rise', `${id}/${section}`);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the view in the address changes
  useEffect(() => {
    let live = true;
    client.get(id, view.filters).then(
      (p) => {
        if (!live) return;
        setPlan(p);
        setProblem(null);
      },
      (error) => {
        if (!live) return;
        setProblem(
          error instanceof ApiError && error.status === 404
            ? 'missing'
            : error instanceof ApiError && error.status === 400
              ? 'filter'
              : 'failed',
        );
      },
    );
    return () => {
      live = false;
    };
  }, [client, id, viewKey, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after the settings are saved
  useEffect(() => {
    let live = true;
    client.choices(id).then(
      (c) => live && setChoices(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, id, version]);

  if (problem === 'missing') {
    return (
      <section className="plan-page">
        <p className="board-problem" role="alert">
          {t('plans.notFound')}
        </p>
        <a href={routeHref('#/plans')}>{t('plans.backToList')}</a>
      </section>
    );
  }
  if (problem === 'filter') return <FilterProblem id={id} section={section} />;
  if (!plan && problem === 'failed') {
    return (
      <p className="board-problem" role="alert">
        {t('plans.failed')}
      </p>
    );
  }
  if (!plan) return <p className="report-empty">{t('reports.loading')}</p>;

  const go = (next: PlanView) => navigate(planHref(id, section, next));
  const tabs = PLAN_SECTIONS.filter((s) => s.id !== 'settings' || plan.editable);
  const broken = plan.sources.filter((s) => s.kind === 'savedSearch' && s.state === 'broken');
  const archived = plan.sources.filter((s) => s.kind === 'track' && s.state === 'archived');
  const grouped = section === 'timeline' || section === 'list';
  const viewProps = { id, plan, filters: view.filters, client, now };

  return (
    <section className="plan-page" aria-labelledby={titleId}>
      <div className="board-header">
        <h1 id={titleId} className="page-title">
          {plan.name}
        </h1>
        <p className="board-meta">{t('plans.meta', { owner: plan.owner.name })}</p>
      </div>
      {plan.description && <p className="plan-description">{plan.description}</p>}
      <nav className="track-tabs" aria-label={t('plans.sections', { name: plan.name })}>
        <ul>
          {tabs.map((s) => (
            <li key={s.id}>
              <a
                href={routeHref(planHref(id, s.id, s.id === 'settings' ? undefined : view))}
                aria-current={s.id === section ? 'page' : undefined}
              >
                {t(s.labelId)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {(plan.hiddenSources > 0 || broken.length > 0 || archived.length > 0 || !plan.query) && (
        <ul className="plan-notices">
          {plan.query === null && plan.sources.length === 0 && plan.hiddenSources > 0 && (
            <li>{t('plans.notice.nothing')}</li>
          )}
          {/* Sources the person sees, none of them searchable: archived or no longer running. */}
          {plan.query === null && plan.sources.length > 0 && (
            <li>{t('plans.notice.unsearchable')}</li>
          )}
          {plan.sources.length + plan.hiddenSources === 0 && <li>{t('plans.notice.noSources')}</li>}
          {plan.hiddenSources > 0 && (
            <li>{t('plans.notice.hidden', { count: plan.hiddenSources })}</li>
          )}
          {broken.map((s) => (
            <li key={`b${s.id}`}>{t('plans.notice.broken', { name: s.name })}</li>
          ))}
          {archived.map((s) => (
            <li key={`a${s.id}`}>{t('plans.notice.archived', { name: s.name })}</li>
          ))}
        </ul>
      )}
      {section !== 'settings' && (
        <PlanFilterBar view={view} choices={choices} grouped={grouped} onChange={go} />
      )}
      <div ref={body}>
        {/* The plan for this address did not load: no view runs with the last address's query. */}
        {problem === 'failed' && (
          <p className="board-problem" role="alert">
            {t('plans.failed')}
          </p>
        )}
        {problem !== 'failed' && section === 'summary' && <PlanSummaryPage {...viewProps} />}
        {problem !== 'failed' && section === 'timeline' && (
          <PlanTimelinePage {...viewProps} group={view.group} />
        )}
        {problem !== 'failed' && section === 'list' && (
          <PlanListPage {...viewProps} group={view.group} search={search} list={list} />
        )}
        {problem !== 'failed' && section === 'calendar' && <PlanCalendarPage {...viewProps} />}
        {problem !== 'failed' && section === 'capacity' && <PlanCapacityPage {...viewProps} />}
        {problem !== 'failed' && section === 'settings' && plan.editable && (
          <PlanSettingsPage plan={plan} client={client} onSaved={() => setVersion((v) => v + 1)} />
        )}
      </div>
    </section>
  );
}

/** A filter in the address that does not read: say so, and offer the plan without filters. */
function FilterProblem({ id, section }: { id: number; section: PlanSection }) {
  const t = useT();
  return (
    <section className="plan-page">
      <p className="board-problem" role="alert">
        {t('plans.filterProblem')}
      </p>
      <a href={routeHref(planHref(id, section))}>{t('plans.filters.clear')}</a>
    </section>
  );
}

/** The filters, one value each, and the grouping where the view groups (PLN-012). */
function PlanFilterBar({
  view,
  choices,
  grouped,
  onChange,
}: {
  view: PlanView;
  choices: PlanChoices | null;
  grouped: boolean;
  onChange: (view: PlanView) => void;
}) {
  const t = useT();
  const id = useId();
  const { filters } = view;
  const set = (key: keyof typeof filters, value: string) =>
    onChange({ ...view, filters: { ...filters, [key]: value || undefined } });
  const any = Object.values(filters).some(Boolean);
  // A value from the address that the choices do not list still shows as chosen.
  const tracks = choices?.tracks ?? [];
  const types = choices?.types ?? [];
  const people = choices?.assignees ?? [];
  return (
    <form
      className="plan-filters"
      aria-label={t('plans.filters')}
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="form-field" htmlFor={`${id}-track`}>
        <span className="form-label">{t('plans.filter.track')}</span>
        <select
          id={`${id}-track`}
          value={filters.track ?? ''}
          onChange={(e) => set('track', e.target.value)}
        >
          <option value="">{t('plans.filter.any')}</option>
          {filters.track && !tracks.some((x) => x.key === filters.track) && (
            <option value={filters.track}>{filters.track}</option>
          )}
          {tracks.map((x) => (
            <option key={x.id} value={x.key}>
              {x.name === null
                ? x.key
                : t('plans.filter.trackOption', { key: x.key, name: x.name })}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field" htmlFor={`${id}-assignee`}>
        <span className="form-label">{t('plans.filter.assignee')}</span>
        <select
          id={`${id}-assignee`}
          value={filters.assignee ?? ''}
          onChange={(e) => set('assignee', e.target.value)}
        >
          <option value="">{t('plans.filter.any')}</option>
          <option value="me">{t('plans.filter.me')}</option>
          <option value="none">{t('plans.filter.nobody')}</option>
          {filters.assignee &&
            !['me', 'none'].includes(filters.assignee) &&
            !people.some((p) => String(p.id) === filters.assignee) && (
              <option value={filters.assignee}>{t('plans.filter.person')}</option>
            )}
          {people.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field" htmlFor={`${id}-type`}>
        <span className="form-label">{t('plans.filter.type')}</span>
        <select
          id={`${id}-type`}
          value={filters.type ?? ''}
          onChange={(e) => set('type', e.target.value)}
        >
          <option value="">{t('plans.filter.any')}</option>
          {filters.type && !types.some((x) => x.name === filters.type) && (
            <option value={filters.type}>{typeName(t, filters.type)}</option>
          )}
          {types.map((x) => (
            <option key={x.name} value={x.name}>
              {typeName(t, x.name)}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field" htmlFor={`${id}-stage`}>
        <span className="form-label">{t('plans.filter.stage')}</span>
        <select
          id={`${id}-stage`}
          value={filters.stage ?? ''}
          onChange={(e) => set('stage', e.target.value)}
        >
          <option value="">{t('plans.filter.any')}</option>
          {STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {t(s.label)}
            </option>
          ))}
        </select>
      </label>
      {grouped && (
        <label className="form-field" htmlFor={`${id}-group`}>
          <span className="form-label">{t('plans.groupBy')}</span>
          <select
            id={`${id}-group`}
            value={view.group ?? 'none'}
            onChange={(e) =>
              onChange({
                ...view,
                group: e.target.value === 'none' ? null : (e.target.value as PlanGroup),
              })
            }
          >
            {(['none', ...PLAN_GROUPS] as const).map((g) => (
              <option key={g} value={g}>
                {t(GROUP_LABELS[g])}
              </option>
            ))}
          </select>
        </label>
      )}
      {any && (
        <button
          type="button"
          className="button-secondary"
          onClick={() => onChange({ ...view, filters: {} })}
        >
          {t('plans.filters.clear')}
        </button>
      )}
    </form>
  );
}

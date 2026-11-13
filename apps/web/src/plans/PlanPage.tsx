import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { type ListClient, listClient } from '../list/client';
import { navigate, redirectRoute, routeHref, useRoute } from '../routing/router';
import { type SearchClient, searchClient } from '../search/client';
import { useMotionOnChange } from '../shell/motion';
import { NotFoundPage } from '../shell/NotFoundPage';
import { PageHeader } from '../shell/PageHeader';
import { typeName } from '../shell/seededNames';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import {
  GROUP_LABELS,
  PLAN_GROUPS,
  PLAN_SECTIONS,
  type PlanGroup,
  type PlanPosition,
  type PlanSection,
  type PlanView,
  planHref,
  planViewKey,
  readView,
} from './address';
import { type Plan, type PlanChoices, type PlanClient, planClient } from './client';
import { PlanCalendarPage } from './PlanCalendarPage';
import { PlanCapacityPage } from './PlanCapacityPage';
import { PlanListPage } from './PlanListPage';
import { PlanReleasesPage } from './PlanReleasesPage';
import { PlanSettingsPage } from './PlanSettingsPage';
import { PlanShareActions } from './PlanShareActions';
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

/**
 * Scrolls a tab bar sideways so its current tab shows whole (PL-17): on a phone the later tabs
 * start off-screen, and the one open must not be among them.
 */
export function showCurrentTab(nav: HTMLElement | null): void {
  const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!nav || !current) return;
  const bar = nav.getBoundingClientRect();
  const tab = current.getBoundingClientRect();
  // A little of the next tab shows too, so the bar reads as one that goes on.
  const room = 24;
  if (tab.right > bar.right) nav.scrollLeft += tab.right - bar.right + room;
  else if (tab.left < bar.left) nav.scrollLeft -= bar.left - tab.left + room;
}

const STAGES = [
  { id: 'new', label: 'search.stage.new' },
  { id: 'active', label: 'search.stage.active' },
  { id: 'closed', label: 'search.stage.closed' },
] as const satisfies readonly { id: string; label: MessageId }[];

/**
 * One Multi-track plan (T-088; PLN-001, PLN-012; ADR-122): its name and owner, a tab bar of its
 * Summary, Timeline, List, Calendar, Capacity (PLN-005, PLN-009) and Releases (PLN-007), and Settings for those who
 * may change it, the current tab scrolled into view, and the
 * filters every view shares (behind one Filters button on a phone), one value each, with the grouping of the Timeline and the List. The
 * filters and the grouping live in the page's address, so a link opens the same view and the
 * browser's back button undoes a change. Where a view stands (zoom, month, first day, order) is in
 * the address too, replacing its entry, so a link holds it and back still undoes filters, not every
 * step (PLN-014). The plan shows only what the person may see; the page says when some of its
 * sources are hidden from them or no longer run. Every tab offers a link to the view and a copy of
 * the plan, and each view its own file.
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
  const viewKey = planViewKey(id, view);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<'missing' | 'filter' | 'failed' | null>(null);
  const [choices, setChoices] = useState<PlanChoices | null>(null);
  const [version, setVersion] = useState(0);
  const body = useMotionOnChange<HTMLDivElement>('motion-rise', `${id}/${section}`);
  const tabBar = useRef<HTMLElement>(null);
  const loaded = plan !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each section, once the bar is drawn
  useLayoutEffect(() => showCurrentTab(tabBar.current), [section, loaded]);

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
    return <NotFoundPage title={t('notFound.plan')}>{t('plans.notFound')}</NotFoundPage>;
  }
  if (problem === 'filter') return <FilterProblem id={id} section={section} />;
  if (!plan && problem === 'failed') {
    return (
      <section className="page plan-page" aria-labelledby={titleId}>
        <PageHeader titleId={titleId} title={t('nav.plans')} purpose={t('purpose.plans')} />
        <p className="board-problem" role="alert">
          {t('plans.failed')}
        </p>
      </section>
    );
  }
  if (!plan) return <p className="report-loading">{t('reports.loading')}</p>;

  const go = (next: PlanView) => navigate(planHref(id, section, next));
  const tabs = PLAN_SECTIONS.filter((s) => s.id !== 'settings' || plan.editable);
  const broken = plan.sources.filter((s) => s.kind === 'savedSearch' && s.state === 'broken');
  const archived = plan.sources.filter((s) => s.kind === 'track' && s.state === 'archived');
  const grouped = section === 'timeline' || section === 'list';
  const wide = section === 'timeline' || section === 'capacity';
  const onPosition = (change: PlanPosition) =>
    redirectRoute(planHref(id, section, { ...view, position: { ...view.position, ...change } }));
  const viewProps = {
    id,
    plan,
    filters: view.filters,
    client,
    now,
    position: view.position ?? {},
    onPosition,
  };

  return (
    <section
      // A timeline or a table of periods needs the width; the other sections read at the page's.
      className={wide ? 'page page-full plan-page' : 'page plan-page'}
      aria-labelledby={titleId}
    >
      <PageHeader
        titleId={titleId}
        title={plan.name}
        eyebrow={t('plans.meta', { owner: plan.owner.name })}
        purpose={t('purpose.plan')}
        actions={<PlanShareActions plan={plan} client={client} />}
      />
      {plan.description && <p className="plan-description">{plan.description}</p>}
      <nav
        ref={tabBar}
        className="track-tabs"
        aria-label={t('plans.sections', { name: plan.name })}
      >
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
        {problem !== 'failed' && section === 'releases' && <PlanReleasesPage {...viewProps} />}
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
  const titleId = useId();
  return (
    <section className="page plan-page" aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        title={t('nav.plans')}
        purpose={t('purpose.plan')}
        actions={
          <a className="button-quiet" href={routeHref(planHref(id, section))}>
            {t('plans.filters.clear')}
          </a>
        }
      />
      <p className="board-problem" role="alert">
        {t('plans.filterProblem')}
      </p>
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
  // On a phone the filters wait behind one button, so the plan's work shows first (D33).
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);
  const { filters } = view;
  const set = (key: keyof typeof filters, value: string) =>
    onChange({ ...view, filters: { ...filters, [key]: value || undefined } });
  const active = Object.values(filters).filter(Boolean).length;
  const any = active > 0;
  // A value from the address that the choices do not list still shows as chosen.
  const tracks = choices?.tracks ?? [];
  const types = choices?.types ?? [];
  const people = choices?.assignees ?? [];
  return (
    <>
      {compact && (
        <button
          type="button"
          className="button-secondary plan-filters-toggle"
          aria-expanded={open}
          aria-controls={`${id}-filters`}
          onClick={() => setOpen((was) => !was)}
        >
          {t('plans.filters.button', { count: active })}
        </button>
      )}
      <form
        id={`${id}-filters`}
        className="plan-filters"
        aria-label={t('plans.filters')}
        hidden={compact && !open}
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
    </>
  );
}

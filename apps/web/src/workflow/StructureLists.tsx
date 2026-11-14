import { type Ref, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { EmptyState } from '../shell/EmptyState';
import type { GuardNode, Stage, Status, WorkflowDefinition } from './definition';
import { type Names, STAGE_LABELS } from './describe';
import type { LintIssue } from './lint';
import type { Selection } from './WorkflowDiagram';

export interface StructureListsProps {
  definition: WorkflowDefinition;
  /** Every status of the workspace, for adding one to the workflow. */
  statuses: readonly Status[];
  stages: ReadonlyMap<number, Stage>;
  names: Names;
  issues: readonly LintIssue[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onAddStatus: (statusId: number) => void;
  onAddTransition: () => void;
  statusesHeadingRef?: Ref<HTMLHeadingElement>;
  transitionsHeadingRef?: Ref<HTMLHeadingElement>;
}

/** How many guards a tree holds, groups not counted. */
export function countGuards(node: GuardNode | undefined): number {
  if (!node) return 0;
  if ('all' in node) return node.all.reduce((n, c) => n + countGuards(c), 0);
  if ('any' in node) return node.any.reduce((n, c) => n + countGuards(c), 0);
  return 1;
}

/**
 * The workflow's statuses and transitions as lists (M1-030): the keyboard and screen reader
 * equivalent of the diagram, and where statuses are added to the workflow and transitions
 * created. Choosing an entry opens it in the details panel.
 */
export function StructureLists({
  definition,
  statuses,
  stages,
  names,
  issues,
  selection,
  onSelect,
  onAddStatus,
  onAddTransition,
  statusesHeadingRef,
  transitionsHeadingRef,
}: StructureListsProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const inWorkflow = new Set(definition.statuses.map((s) => s.statusId));
  const available = statuses.filter((s) => !inWorkflow.has(s.id));
  const [adding, setAdding] = useState('');
  const chosen = available.some((s) => String(s.id) === adding)
    ? adding
    : String(available[0]?.id ?? '');
  const tagsFor = (statusId: number) =>
    issues.flatMap((i) =>
      'statusId' in i && i.statusId === statusId && i.kind === 'unreachable-status'
        ? [t('workflow.lint.unreachableTag')]
        : 'statusId' in i && i.statusId === statusId && i.kind === 'no-exit'
          ? [t('workflow.lint.noExitTag')]
          : [],
    );
  const neverOffered = new Set(
    issues.flatMap((i) => (i.kind === 'unsatisfiable-guard' ? [i.transitionId] : [])),
  );

  return (
    <div className="workflow-structure" data-tutorial="workflow-structure">
      <section aria-labelledby={`${id}-statuses`} className="glass-card workflow-structure-part">
        <h2 id={`${id}-statuses`} ref={statusesHeadingRef} tabIndex={-1} className="facts-title">
          {t('admin.workflow.statuses')}
        </h2>
        <ol className="workflow-entries" aria-labelledby={`${id}-statuses`}>
          {definition.statuses.map(({ statusId }, index) => {
            const stage = stages.get(statusId);
            const selected = selection?.kind === 'status' && selection.id === statusId;
            const tags = tagsFor(statusId);
            return (
              // A repeated status is an error the checks name; its entries still need keys.
              // biome-ignore lint/suspicious/noArrayIndexKey: a status may be listed twice
              <li key={`${statusId}-${index}`} className="workflow-entry">
                <button
                  type="button"
                  className={`workflow-pick stage-${stage ?? 'unknown'}`}
                  aria-current={selected ? 'true' : undefined}
                  aria-describedby={`${id}-s-${index}`}
                  onClick={() => onSelect({ kind: 'status', id: statusId })}
                >
                  {names.status(statusId)}
                </button>
                <span id={`${id}-s-${index}`} className="workflow-entry-meta">
                  {stage && (
                    <span className={`stage-badge stage-${stage}`}>
                      {t('workflow.stageBadge', { stage: t(STAGE_LABELS[stage]) })}
                    </span>
                  )}
                  {definition.initialStatusId === statusId && (
                    <span className="token-badge">{t('admin.workflow.initialBadge')}</span>
                  )}
                  {tags.map((tag) => (
                    <span key={tag} className="lint-tag">
                      {tag}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ol>
        {available.length > 0 ? (
          <div className="rule-add">
            <div className="form-field">
              <label htmlFor={`${id}-add-status`}>{t('admin.workflow.addStatus')}</label>
              <select
                id={`${id}-add-status`}
                value={chosen}
                onChange={(e) => setAdding(e.target.value)}
              >
                {available.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {t('common.value', { value: s.name })}
                  </option>
                ))}
              </select>
            </div>
            {/* Filled, like every add action in administration (D11, AD-19). */}
            <button
              type="button"
              className="button-primary"
              onClick={() => chosen && onAddStatus(Number(chosen))}
            >
              {t('admin.workflow.addStatusButton')}
            </button>
          </div>
        ) : (
          <p className="form-hint">{t('admin.workflow.allStatusesUsed')}</p>
        )}
      </section>

      <section aria-labelledby={`${id}-transitions`} className="glass-card workflow-structure-part">
        <h2
          id={`${id}-transitions`}
          ref={transitionsHeadingRef}
          tabIndex={-1}
          className="facts-title"
        >
          {t('admin.workflow.transitions')}
        </h2>
        {definition.transitions.length === 0 ? (
          <EmptyState compact title={t('admin.workflow.noTransitions')} />
        ) : (
          <ol className="workflow-entries" aria-labelledby={`${id}-transitions`}>
            {definition.transitions.map((x, index) => {
              const selected = selection?.kind === 'transition' && selection.id === x.id;
              const route =
                x.from === 'any'
                  ? t('admin.workflow.routeAny', { to: names.status(x.to) })
                  : t('admin.workflow.route', {
                      from: intl.formatList(
                        x.from.map((s) => names.status(s)),
                        {
                          type: 'disjunction',
                        },
                      ),
                      to: names.status(x.to),
                    });
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: ids may repeat in a bad draft
                <li key={`${x.id}-${index}`} className="workflow-entry">
                  <button
                    type="button"
                    className="workflow-pick"
                    aria-current={selected ? 'true' : undefined}
                    aria-describedby={`${id}-t-${index}`}
                    onClick={() => onSelect({ kind: 'transition', id: x.id })}
                  >
                    {names.transition(x.id)}
                  </button>
                  <span id={`${id}-t-${index}`} className="workflow-entry-meta">
                    <span>{route}</span>
                    <span>
                      {t('admin.workflow.ruleCounts', {
                        guards: countGuards(x.guards),
                        checks: x.checks?.length ?? 0,
                        effects: x.effects?.length ?? 0,
                      })}
                    </span>
                    {neverOffered.has(x.id) && (
                      <span className="lint-tag">{t('workflow.lint.neverOfferedTag')}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="rule-actions">
          <button type="button" className="button-secondary" onClick={onAddTransition}>
            {t('admin.workflow.addTransition')}
          </button>
        </div>
      </section>
    </div>
  );
}

import { type Ref, useId } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { DangerAction } from '../shell/DangerAction';
import {
  type Stage,
  type StatusPermissions,
  startsFrom,
  statusRemoval,
  type WorkflowDefinition,
} from './definition';
import { type Names, STAGE_LABELS } from './describe';

export interface StatusInspectorProps {
  statusId: number;
  /** The status's stage in the workspace; undefined when the workspace no longer has it. */
  stage: Stage | undefined;
  definition: WorkflowDefinition;
  names: Names;
  onMakeInitial: () => void;
  onAddTransition: () => void;
  onRemove: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

const ACTIONS: [keyof StatusPermissions, MessageId][] = [
  ['edit', 'admin.workflow.status.action.edit'],
  ['comment', 'admin.workflow.status.action.comment'],
  ['attach', 'admin.workflow.status.action.attach'],
  ['assign', 'admin.workflow.status.action.assign'],
  ['transition', 'admin.workflow.status.action.transition'],
];

/**
 * One status of the workflow (WF-001, WF-002, WF-007): its stage, whether tickets start there,
 * the transitions in and out, and the guided removal that says which transitions go with it
 * and that its tickets move where the publish mapping says.
 */
export function StatusInspector({
  statusId,
  stage,
  definition,
  names,
  onMakeInitial,
  onAddTransition,
  onRemove,
  headingRef,
}: StatusInspectorProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const initial = definition.initialStatusId === statusId;
  const name = names.status(statusId);
  const list = (ids: number[]) => intl.formatList(ids.map((x) => names.transition(x)));
  const into = definition.transitions.filter((x) => x.to === statusId).map((x) => x.id);
  const out = definition.transitions
    .filter((x) => startsFrom(x, statusId) && x.to !== statusId)
    .map((x) => x.id);
  const restricted = definition.statusPermissions?.[String(statusId)];
  const restrictedActions = ACTIONS.filter(([action]) => restricted?.[action] !== undefined);
  const removal = statusRemoval(definition, statusId);

  return (
    <section className="glass-card workflow-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="facts-title">
        {t('admin.workflow.status.heading', { name })}
      </h2>
      {stage && (
        <p>
          <span className={`stage-badge stage-${stage}`}>
            {t('workflow.stageBadge', { stage: t(STAGE_LABELS[stage]) })}
          </span>
        </p>
      )}
      {initial ? (
        <p className="page-note">{t('admin.workflow.status.isInitial')}</p>
      ) : (
        <div className="rule-actions">
          <button type="button" className="button-secondary" onClick={onMakeInitial}>
            {t('admin.workflow.status.makeInitial')}
          </button>
        </div>
      )}
      <p className="page-note">
        {t('admin.workflow.status.into', { count: into.length, names: list(into) })}
      </p>
      <p className="page-note">
        {t('admin.workflow.status.out', { count: out.length, names: list(out) })}
      </p>
      {restrictedActions.length > 0 && (
        <p className="page-note">
          {t('admin.workflow.status.permissions', {
            actions: intl.formatList(restrictedActions.map(([, label]) => t(label))),
          })}
        </p>
      )}
      <div className="rule-actions">
        <button type="button" className="button-secondary" onClick={onAddTransition}>
          {t('admin.workflow.status.addTransition', { name })}
        </button>
      </div>
      <div className="workflow-danger">
        {initial ? (
          <p className="form-hint">{t('admin.workflow.status.removeInitial')}</p>
        ) : (
          // Asks first, saying what will happen (D13): the transitions it takes along, and that
          // its tickets move when the draft is published.
          <DangerAction
            label={t('admin.workflow.status.remove', { name })}
            outcome={
              <>
                {t('admin.workflow.status.confirmRemove', { name })}
                {removal.removed.length > 0 && (
                  <>
                    {' '}
                    {t('admin.workflow.status.removesTransitions', {
                      count: removal.removed.length,
                      names: list(removal.removed.map((x) => x.id)),
                    })}
                  </>
                )}
                {removal.trimmed.length > 0 && (
                  <>
                    {' '}
                    {t('admin.workflow.status.trimsTransitions', {
                      count: removal.trimmed.length,
                      names: list(removal.trimmed.map((x) => x.id)),
                    })}
                  </>
                )}{' '}
                {t('admin.workflow.status.ticketsMove', { name })}
              </>
            }
            confirmLabel={t('admin.workflow.status.remove', { name })}
            onConfirm={onRemove}
          />
        )}
      </div>
    </section>
  );
}

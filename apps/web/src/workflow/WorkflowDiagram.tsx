import { useId, useMemo } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { Stage, WorkflowDefinition } from './definition';
import type { Names } from './describe';
import { layoutDiagram, NODE_HEIGHT, NODE_WIDTH } from './diagram';

export type Selection = { kind: 'status'; id: number } | { kind: 'transition'; id: number } | null;

export interface WorkflowDiagramProps {
  definition: WorkflowDefinition;
  stages: ReadonlyMap<number, Stage>;
  names: Names;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Statuses and transitions the checks flag, drawn with a warning edge. */
  flagged?: { statuses: ReadonlySet<number>; transitions: ReadonlySet<number> };
}

/**
 * The workflow as a picture (WF-002 diagram mode, M1-030): statuses coloured by stage,
 * transitions as arrows, global ones as tabs above their target. Pointer users click a box or
 * a label to edit it. The picture is hidden from assistive technology and its parts are out of
 * the tab order: the lists beside it hold the same statuses and transitions and are what the
 * keyboard and screen readers use. The frame itself takes focus so it scrolls with the keys.
 */
export function WorkflowDiagram({
  definition,
  stages,
  names,
  selection,
  onSelect,
  flagged,
}: WorkflowDiagramProps) {
  const t = useT();
  const id = useId();
  const diagram = useMemo(() => layoutDiagram(definition), [definition]);
  const arrow = `${id}-arrow`;
  const arrowSelected = `${id}-arrow-selected`;
  const selectedTransition = selection?.kind === 'transition' ? selection.id : null;
  const selectedStatus = selection?.kind === 'status' ? selection.id : null;

  return (
    <div className="workflow-diagram-frame">
      <section
        className="workflow-diagram"
        aria-label={t('admin.workflow.diagram')}
        aria-describedby={`${id}-hint`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region takes focus so keyboard users can scroll it (WCAG 2.1.1)
        tabIndex={0}
      >
        <div
          className="workflow-diagram-canvas"
          style={{ width: diagram.width, height: diagram.height }}
          aria-hidden="true"
        >
          <svg
            className="workflow-diagram-lines"
            width={diagram.width}
            height={diagram.height}
            viewBox={`0 0 ${diagram.width} ${diagram.height}`}
            focusable="false"
            aria-hidden="true"
          >
            <defs>
              <marker
                id={arrow}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" className="workflow-arrow" />
              </marker>
              <marker
                id={arrowSelected}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" className="workflow-arrow workflow-arrow-selected" />
              </marker>
            </defs>
            {diagram.edges.map((edge) => {
              const selected = edge.transitionId === selectedTransition;
              const classes = [
                'workflow-edge',
                `workflow-edge-${edge.kind}`,
                selected ? 'workflow-edge-selected' : '',
                flagged?.transitions.has(edge.transitionId) ? 'workflow-edge-flagged' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <path
                  key={edge.key}
                  d={edge.path}
                  className={classes}
                  markerEnd={`url(#${selected ? arrowSelected : arrow})`}
                />
              );
            })}
          </svg>
          {diagram.nodes.map((node) => {
            const stage = stages.get(node.statusId);
            const classes = [
              'workflow-node',
              `stage-${stage ?? 'unknown'}`,
              node.statusId === selectedStatus ? 'workflow-node-selected' : '',
              !node.reachable || flagged?.statuses.has(node.statusId)
                ? 'workflow-node-flagged'
                : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={node.statusId}
                type="button"
                tabIndex={-1}
                className={classes}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                onClick={() => onSelect({ kind: 'status', id: node.statusId })}
              >
                <span className="workflow-node-name">{names.status(node.statusId)}</span>
                {node.initial && (
                  <span className="workflow-node-mark">{t('admin.workflow.initialMark')}</span>
                )}
              </button>
            );
          })}
          {diagram.edges.map((edge) => {
            if (!edge.label) return null;
            const selected = edge.transitionId === selectedTransition;
            const name = names.transition(edge.transitionId);
            return (
              <button
                key={`${edge.key}-label`}
                type="button"
                tabIndex={-1}
                className={`workflow-edge-label${edge.kind === 'global' ? ' workflow-edge-tab' : ''}${
                  selected ? ' workflow-edge-label-selected' : ''
                }`}
                style={{ left: edge.label.x, top: edge.label.y, maxWidth: edge.label.width }}
                onClick={() => onSelect({ kind: 'transition', id: edge.transitionId })}
              >
                {edge.kind === 'global' ? t('admin.workflow.globalTab', { name }) : name}
              </button>
            );
          })}
        </div>
      </section>
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.workflow.diagramHint')}
      </p>
    </div>
  );
}

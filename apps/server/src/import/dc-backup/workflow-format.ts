import { SaxesParser } from 'saxes';
import { escapeAttr, escapeText } from './xml';

/**
 * Workflows as a Data Center backup holds them (M1-090; IMP-004; ADR-093), from general
 * knowledge of the format, every rule marked **Verify** in the format notes (02d) until a design
 * partner's backup confirms it. A `Workflow` row carries its whole definition as one XML
 * document, the descriptor: its steps (each tied to a status), the initial action that creates
 * an issue, global actions offered from every step, common actions shared by several steps, and
 * each step's own actions. An action (a transition) restricts who may run it with nested
 * condition groups, checks its input with validators, and runs post functions from its result;
 * conditions, validators and functions name the class that implements them, with arguments.
 * Workflow schemes give each issue type its workflow, and projects use a scheme through
 * `NodeAssociation` rows. Custom events are `EventType` rows that a transition can fire.
 *
 * This is the format layer, in the backup's own vocabulary (step, action, issue). The generator
 * writes descriptors with `writeDescriptor`, the validator and the stage read them with
 * `parseDescriptor`, so both sides agree on one model.
 */

// --- Elements ---------------------------------------------------------------------------------

const id = { type: 'id' } as const;
const text = { type: 'text' } as const;
const optText = { type: 'text', optional: true } as const;

/**
 * The elements of this part, with their attributes (merged into `format.ts`'s `ENTITIES`, which
 * checks their shape; no import back, so the two files stay acyclic).
 */
export const WORKFLOW_ENTITIES = {
  EventType: { attrs: { id, name: text, description: optText, type: optText } },
  Workflow: {
    attrs: {
      id,
      name: text,
      creatorname: optText,
      descriptor: { type: 'text', long: true },
      islocked: optText,
    },
  },
  WorkflowScheme: { attrs: { id, name: text, description: optText } },
  WorkflowSchemeEntity: {
    // `workflow` names the workflow by name; `issuetype` is a type's id, or `0` for the rest.
    attrs: { id, scheme: { type: 'ref', to: 'WorkflowScheme' }, workflow: text, issuetype: text },
  },
} as const;

export const WORKFLOW_ELEMENTS = Object.keys(
  WORKFLOW_ENTITIES,
) as (keyof typeof WORKFLOW_ENTITIES)[];

/** The built-in workflow, which the backup names but does not hold (Verify). */
export const SYSTEM_WORKFLOW = 'jira';
/** A scheme entity's `issuetype` for every type the scheme does not name (Verify). */
export const ALL_OTHER_TYPES = '0';
/** Custom events have ids from here; lower ones are the system's (as in notifications). */
export const FIRST_CUSTOM_EVENT = 10_000;
/** `EventType.type` of a custom event (Verify). */
export const CUSTOM_EVENT_TYPE = 'jira.custom.event.type';

/** Meta keys of steps and actions (Verify). */
export const META = {
  /** A step's status, by the `Status` row's id. */
  status: 'jira.status.id',
  /** An action's screen, by the `FieldScreen` row's id. */
  screen: 'jira.fieldscreen.id',
  description: 'jira.description',
  /** A step property that, set to `false`, locks the issue's fields in that step. */
  editable: 'jira.issue.editable',
  /** Prefix of a step property that limits a permission in the step to a grantee. */
  permission: 'jira.permission.',
} as const;

/** The argument that holds a function's, condition's or validator's class (Verify). */
export const CLASS_ARG = 'class.name';

/** The first lines of a descriptor: a declaration and the document type (Verify). */
export const DESCRIPTOR_PROLOG =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE workflow PUBLIC "-//OpenSymphony Group//DTD OSWorkflow 2.8//EN" ' +
  '"http://www.opensymphony.com/osworkflow/workflow_2_8.dtd">\n';

// --- The descriptor model ---------------------------------------------------------------------

/** A condition, validator or function: `class` with a class name, or a script type. */
export interface WfFunction {
  type: string;
  /** The `class.name` argument; null for a script. */
  className: string | null;
  /** The other arguments, by name. */
  args: Record<string, string>;
}

export interface WfCondition extends WfFunction {
  negate: boolean;
}

/** A condition group: all of its items (`AND`) or one of them (`OR`). */
export interface WfConditions {
  operator: 'AND' | 'OR';
  items: (WfConditions | WfCondition)[];
}

export const isGroup = (c: WfConditions | WfCondition): c is WfConditions => 'operator' in c;

export interface WfResult {
  /** The step the issue moves to. */
  step: number | null;
  oldStatus: string | null;
  status: string | null;
  /** A conditional result's conditions; none on the unconditional one. */
  conditions: WfConditions | null;
  validators: WfFunction[];
  postFunctions: WfFunction[];
}

export interface WfAction {
  id: number;
  name: string;
  view: string | null;
  meta: Record<string, string>;
  /** Who may run it (`restrict-to`). */
  conditions: WfConditions | null;
  validators: WfFunction[];
  preFunctions: WfFunction[];
  /** The result taken when no conditional one applies. */
  result: WfResult | null;
  /** Results that apply only when their conditions hold, in order. */
  conditionalResults: WfResult[];
  /** Functions of the action itself, after its result's. */
  postFunctions: WfFunction[];
}

export interface WfStep {
  id: number;
  name: string;
  meta: Record<string, string>;
  actions: WfAction[];
  /** Ids of common actions this step offers. */
  commonActions: number[];
}

export interface WfDescriptor {
  meta: Record<string, string>;
  initialActions: WfAction[];
  globalActions: WfAction[];
  commonActions: WfAction[];
  steps: WfStep[];
}

// --- Writing ----------------------------------------------------------------------------------

function writeArgs(f: WfFunction, pad: string): string {
  const args: [string, string][] = [
    ...(f.className === null ? [] : ([[CLASS_ARG, f.className]] as [string, string][])),
    ...Object.entries(f.args),
  ];
  return args
    .map(([k, v]) => `${pad}<arg name="${escapeAttr(k)}">${escapeText(v)}</arg>\n`)
    .join('');
}

function writeFunction(tag: string, f: WfFunction, pad: string, extra = ''): string {
  return `${pad}<${tag}${extra} type="${escapeAttr(f.type)}">\n${writeArgs(f, `${pad}  `)}${pad}</${tag}>\n`;
}

function writeConditions(c: WfConditions, pad: string): string {
  const items = c.items
    .map((item) =>
      isGroup(item)
        ? writeConditions(item, `${pad}  `)
        : writeFunction('condition', item, `${pad}  `, item.negate ? ' negate="true"' : ''),
    )
    .join('');
  return `${pad}<conditions type="${c.operator}">\n${items}${pad}</conditions>\n`;
}

function writeMeta(meta: Record<string, string>, pad: string): string {
  return Object.entries(meta)
    .map(([k, v]) => `${pad}<meta name="${escapeAttr(k)}">${escapeText(v)}</meta>\n`)
    .join('');
}

function writeFunctions(tag: string, inner: string, list: WfFunction[], pad: string): string {
  if (list.length === 0) return '';
  const body = list
    .map((f) => writeFunction(inner, f, `${pad}  `, inner === 'validator' ? ' name=""' : ''))
    .join('');
  return `${pad}<${tag}>\n${body}${pad}</${tag}>\n`;
}

function writeResult(tag: string, r: WfResult, pad: string): string {
  const attrs = [
    r.oldStatus === null ? '' : ` old-status="${escapeAttr(r.oldStatus)}"`,
    r.status === null ? '' : ` status="${escapeAttr(r.status)}"`,
    r.step === null ? '' : ` step="${r.step}"`,
  ].join('');
  const body =
    (r.conditions ? writeConditions(r.conditions, `${pad}  `) : '') +
    writeFunctions('validators', 'validator', r.validators, `${pad}  `) +
    writeFunctions('post-functions', 'function', r.postFunctions, `${pad}  `);
  return body === ''
    ? `${pad}<${tag}${attrs}/>\n`
    : `${pad}<${tag}${attrs}>\n${body}${pad}</${tag}>\n`;
}

function writeAction(a: WfAction, pad: string): string {
  const inner = `${pad}  `;
  const view = a.view === null ? '' : ` view="${escapeAttr(a.view)}"`;
  const results =
    a.result === null && a.conditionalResults.length === 0
      ? ''
      : `${inner}<results>\n${a.conditionalResults.map((r) => writeResult('result', r, `${inner}  `)).join('')}${
          a.result ? writeResult('unconditional-result', a.result, `${inner}  `) : ''
        }${inner}</results>\n`;
  return (
    `${pad}<action id="${a.id}" name="${escapeAttr(a.name)}"${view}>\n` +
    writeMeta(a.meta, inner) +
    (a.conditions
      ? `${inner}<restrict-to>\n${writeConditions(a.conditions, `${inner}  `)}${inner}</restrict-to>\n`
      : '') +
    writeFunctions('validators', 'validator', a.validators, inner) +
    writeFunctions('pre-functions', 'function', a.preFunctions, inner) +
    results +
    writeFunctions('post-functions', 'function', a.postFunctions, inner) +
    `${pad}</action>\n`
  );
}

function writeActions(tag: string, actions: WfAction[], pad: string): string {
  if (actions.length === 0) return '';
  return `${pad}<${tag}>\n${actions.map((a) => writeAction(a, `${pad}  `)).join('')}${pad}</${tag}>\n`;
}

/** A descriptor as the `Workflow` row's `descriptor` text. */
export function writeDescriptor(d: WfDescriptor): string {
  const steps = d.steps
    .map((s) => {
      const actions =
        s.actions.length === 0 && s.commonActions.length === 0
          ? ''
          : `      <actions>\n${s.commonActions.map((c) => `        <common-action id="${c}"/>\n`).join('')}${s.actions
              .map((a) => writeAction(a, '        '))
              .join('')}      </actions>\n`;
      return `    <step id="${s.id}" name="${escapeAttr(s.name)}">\n${writeMeta(s.meta, '      ')}${actions}    </step>\n`;
    })
    .join('');
  return (
    DESCRIPTOR_PROLOG +
    '<workflow>\n' +
    writeMeta(d.meta, '  ') +
    writeActions('initial-actions', d.initialActions, '  ') +
    writeActions('global-actions', d.globalActions, '  ') +
    writeActions('common-actions', d.commonActions, '  ') +
    `  <steps>\n${steps}  </steps>\n` +
    '</workflow>\n'
  );
}

// --- Reading ----------------------------------------------------------------------------------

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

export class DescriptorError extends Error {}

/** A small document as a tree (descriptors are a few kilobytes). */
function tree(xml: string): El {
  const parser = new SaxesParser({ xmlns: false, position: false });
  const stack: El[] = [];
  let root: El | null = null;
  let failure: Error | undefined;
  parser.on('error', (e) => {
    failure ??= e;
  });
  parser.on('opentag', (tag) => {
    const el: El = {
      name: tag.name,
      attrs: { ...(tag.attributes as Record<string, string>) },
      children: [],
      text: '',
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else root ??= el;
    stack.push(el);
  });
  const addText = (t: string) => {
    const top = stack[stack.length - 1];
    if (top) top.text += t;
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(xml);
  parser.close();
  if (failure) throw new DescriptorError(failure.message);
  if (!root) throw new DescriptorError('no root element');
  return root;
}

const child = (el: El, name: string) => el.children.find((c) => c.name === name);
const all = (el: El | undefined, name: string) =>
  el ? el.children.filter((c) => c.name === name) : [];
const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null;

function readMeta(el: El): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of all(el, 'meta')) {
    if (m.attrs.name !== undefined) out[m.attrs.name] = m.text.trim();
  }
  return out;
}

function readFunction(el: El): WfFunction {
  const args: Record<string, string> = {};
  let className: string | null = null;
  for (const a of all(el, 'arg')) {
    const name = a.attrs.name ?? '';
    if (name === CLASS_ARG) className = a.text.trim();
    else args[name] = a.text.trim();
  }
  return { type: el.attrs.type ?? 'class', className, args };
}

function readConditions(el: El): WfConditions {
  const items: (WfConditions | WfCondition)[] = [];
  for (const c of el.children) {
    if (c.name === 'conditions') items.push(readConditions(c));
    else if (c.name === 'condition') {
      items.push({ ...readFunction(c), negate: (c.attrs.negate ?? '').toLowerCase() === 'true' });
    }
  }
  return { operator: (el.attrs.type ?? 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND', items };
}

/** A `restrict-to` or a result: its one `conditions` group, or a lone condition wrapped. */
function conditionsIn(el: El | undefined): WfConditions | null {
  if (!el) return null;
  const group = child(el, 'conditions');
  if (group) return readConditions(group);
  const lone = all(el, 'condition');
  return lone.length === 0 ? null : readConditions({ ...el, children: lone, attrs: {} });
}

const functionsIn = (el: El | undefined, list: string, item: string) =>
  all(child(el ?? { name: '', attrs: {}, children: [], text: '' }, list), item).map(readFunction);

function readResult(el: El): WfResult {
  return {
    step: int(el.attrs.step),
    oldStatus: el.attrs['old-status'] ?? null,
    status: el.attrs.status ?? null,
    conditions: conditionsIn(el),
    validators: functionsIn(el, 'validators', 'validator'),
    postFunctions: functionsIn(el, 'post-functions', 'function'),
  };
}

function readAction(el: El): WfAction {
  const results = child(el, 'results');
  const unconditional = results ? child(results, 'unconditional-result') : undefined;
  return {
    id: int(el.attrs.id) ?? 0,
    name: el.attrs.name ?? '',
    view: el.attrs.view ?? null,
    meta: readMeta(el),
    conditions: conditionsIn(child(el, 'restrict-to')),
    validators: functionsIn(el, 'validators', 'validator'),
    preFunctions: functionsIn(el, 'pre-functions', 'function'),
    result: unconditional ? readResult(unconditional) : null,
    conditionalResults: all(results, 'result').map(readResult),
    postFunctions: functionsIn(el, 'post-functions', 'function'),
  };
}

/** Reads a descriptor; throws `DescriptorError` when it is not one. */
export function parseDescriptor(xml: string): WfDescriptor {
  const root = tree(xml);
  if (root.name !== 'workflow') throw new DescriptorError(`root is ${root.name}, not workflow`);
  const actions = (name: string) => all(child(root, name), 'action').map(readAction);
  return {
    meta: readMeta(root),
    initialActions: actions('initial-actions'),
    globalActions: actions('global-actions'),
    commonActions: actions('common-actions'),
    steps: all(child(root, 'steps'), 'step').map((s) => {
      const list = child(s, 'actions');
      return {
        id: int(s.attrs.id) ?? 0,
        name: s.attrs.name ?? '',
        meta: readMeta(s),
        actions: all(list, 'action').map(readAction),
        commonActions: all(list, 'common-action').flatMap((c) => {
          const n = int(c.attrs.id);
          return n === null ? [] : [n];
        }),
      };
    }),
  };
}

// --- Walking ----------------------------------------------------------------------------------

/** Every action of a descriptor with where it sits. */
export function* actionsOf(
  d: WfDescriptor,
): Generator<{ action: WfAction; place: 'initial' | 'global' | 'common' | 'step'; step?: WfStep }> {
  for (const action of d.initialActions) yield { action, place: 'initial' };
  for (const action of d.globalActions) yield { action, place: 'global' };
  for (const action of d.commonActions) yield { action, place: 'common' };
  for (const step of d.steps)
    for (const action of step.actions) yield { action, place: 'step', step };
}

/** The conditions of a group, depth first. */
export function* conditionLeaves(c: WfConditions | null): Generator<WfCondition> {
  if (!c) return;
  for (const item of c.items) {
    if (isGroup(item)) yield* conditionLeaves(item);
    else yield item;
  }
}

/** Every rule of an action: conditions, validators and functions, with what each is. */
export function* rulesOf(
  a: WfAction,
): Generator<{ kind: 'condition' | 'validator' | 'function'; rule: WfFunction; where: string }> {
  for (const c of conditionLeaves(a.conditions))
    yield { kind: 'condition', rule: c, where: 'restrict-to' };
  for (const v of a.validators) yield { kind: 'validator', rule: v, where: 'validators' };
  for (const f of a.preFunctions) yield { kind: 'function', rule: f, where: 'pre-functions' };
  for (const r of a.conditionalResults) {
    for (const c of conditionLeaves(r.conditions))
      yield { kind: 'condition', rule: c, where: 'result' };
    for (const v of r.validators) yield { kind: 'validator', rule: v, where: 'result' };
    for (const f of r.postFunctions) yield { kind: 'function', rule: f, where: 'result' };
  }
  if (a.result) {
    for (const v of a.result.validators) yield { kind: 'validator', rule: v, where: 'validators' };
    for (const f of a.result.postFunctions)
      yield { kind: 'function', rule: f, where: 'post-functions' };
  }
  for (const f of a.postFunctions) yield { kind: 'function', rule: f, where: 'post-functions' };
}

/**
 * What the manifest counts about a workflow: the generator counts its model, the validator the
 * descriptor it reads back, so both must agree.
 */
export function workflowCases(descriptor: WfDescriptor): Record<string, number> {
  const out: Record<string, number> = {};
  const note = (k: string, by = 1) => {
    out[k] = (out[k] ?? 0) + by;
  };
  note('workflowSteps', descriptor.steps.length);
  for (const { action, place } of actionsOf(descriptor)) {
    if (place === 'initial') continue;
    note('workflowTransitions');
    if (place === 'global') note('workflowGlobalTransitions');
    if (place === 'common') note('workflowCommonTransitions');
    if (action.meta[META.screen] !== undefined) note('workflowScreens');
    if (action.conditionalResults.length > 0) note('workflowConditionalResults');
    const groups = (c: WfConditions | null): number =>
      c === null ? 0 : c.items.filter(isGroup).reduce((n, g) => n + 1 + groups(g), 0);
    note('workflowNestedConditionGroups', groups(action.conditions));
    for (const c of conditionLeaves(action.conditions))
      if (c.negate) note('workflowNegatedConditions');
  }
  for (const { action } of actionsOf(descriptor)) {
    for (const { kind, rule } of rulesOf(action)) {
      note(
        kind === 'condition'
          ? 'workflowConditions'
          : kind === 'validator'
            ? 'workflowValidators'
            : 'workflowFunctions',
      );
      if (rule.className === null) note('workflowScripts');
      else if (!rule.className.startsWith('com.atlassian.')) note('workflowAppRules');
    }
  }
  for (const s of descriptor.steps) {
    if (Object.keys(s.meta).some((k) => k === META.editable || k.startsWith(META.permission))) {
      note('workflowStepProperties');
    }
  }
  return out;
}

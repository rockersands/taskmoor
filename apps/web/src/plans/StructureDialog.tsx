import { OUTPUT_TYPES, type OutputType } from '@taskmoor/formula';
import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { SearchField } from '../search/client';
import { cellEditor, customColumn, SYSTEM_COLUMNS } from '../search/columns';
import { useColumnName } from '../search/useColumnName';
import { ModalDialog } from '../shell/ModalDialog';
import { fieldName } from '../shell/seededNames';
import { GROUP_LABELS, PLAN_GROUPS } from './address';
import type { LinkTypeOption } from './client';
import type { FormulaCheck, GridClient, StructureOutcome } from './grid/client';
import type {
  StructureColumn,
  StructureList,
  StructureSpec,
  StructureStep,
  StructureSummary,
  TotalFn,
} from './grid/types';
import { useRefName } from './grid/words';

export interface StructureDialogProps {
  planId: number;
  client: GridClient;
  list: StructureList;
  /** Custom fields the editor may see: group fields, ticket columns and what totals read. */
  fields: readonly SearchField[];
  /** The structure changed; null makes a new one. */
  structure: StructureSummary | null;
  /** What a new structure starts from: the unsaved default, or nothing but Add tickets. */
  initial?: StructureSpec | undefined;
  refusal: (r: { code: string; limit?: number }) => string;
  /** Saved: the structure as stored, and whether it was made now. */
  onDone: (saved: StructureSummary, made: boolean) => void;
  onClose: () => void;
}

type LinksStep = Extract<StructureStep, { kind: 'links' }>;

/** Custom field types a Group by step takes, when they hold one value. */
const GROUP_TYPES = new Set(['select', 'user', 'team', 'release']);
const SUM_REFS = ['originalEstimate', 'remainingEstimate', 'timeSpent'] as const;
const DAY_REFS = ['start', 'due'] as const;
const TOTAL_FNS: readonly TotalFn[] = ['sum', 'min', 'max', 'count', 'progress'];
const FN_LABELS: Record<TotalFn, MessageId> = {
  sum: 'grid.dialog.fn.sum',
  min: 'grid.dialog.fn.min',
  max: 'grid.dialog.fn.max',
  count: 'grid.dialog.fn.count',
  progress: 'grid.dialog.fn.progress',
};
const OUTPUT_LABELS: Record<OutputType, MessageId> = {
  number: 'grid.dialog.output.number',
  currency: 'grid.dialog.output.currency',
  percentage: 'grid.dialog.output.percentage',
  date: 'grid.dialog.output.date',
  duration: 'grid.dialog.output.duration',
  text: 'grid.dialog.output.text',
};

/** The words of a field the server named in a refusal. */
const FIELD_WORDS: Record<string, MessageId> = {
  not_groupable: 'grid.dialog.problem.notGroupable',
  duplicate: 'grid.dialog.problem.duplicate',
  not_found: 'grid.dialog.problem.gone',
  unknown_field: 'grid.dialog.problem.unknownField',
  not_summable: 'grid.dialog.problem.notSummable',
  required: 'grid.dialog.problem.required',
  not_allowed: 'grid.dialog.problem.notAllowed',
};

const BLANK: StructureSpec = {
  steps: [{ kind: 'insert' }],
  columns: [
    { kind: 'ticket', field: 'key' },
    { kind: 'ticket', field: 'summary' },
  ],
};

/**
 * Making or changing a structure of a plan's Grid (T-089a; PLN-010; ADR-122 stage 10): its name,
 * then its steps in the order they apply (Add tickets, maybe narrowed by a query; up to two Group
 * by; Add children; up to two Add linked tickets), then its columns, each with its check in words.
 * A formula is checked against the server as it is written, and the server checks the whole
 * structure again on save; a refusal is said at the step or column it names. The limits are said
 * beside what they limit. A sheet on a phone, as every dialog.
 */
export function StructureDialog({
  planId,
  client,
  list,
  fields,
  structure,
  initial,
  refusal,
  onDone,
  onClose,
}: StructureDialogProps) {
  const t = useT();
  const id = useId();
  const nameOf = useColumnName(fields);
  const refName = useRefName(fields);
  const start = structure?.spec ?? initial ?? BLANK;
  const limits = list.limits;
  const [name, setName] = useState(structure?.name ?? '');
  const insert = start.steps.find((s) => s.kind === 'insert');
  const [query, setQuery] = useState(insert?.kind === 'insert' ? (insert.query ?? '') : '');
  const [groups, setGroups] = useState<string[]>(
    start.steps.flatMap((s) => (s.kind === 'group' ? [s.field] : [])),
  );
  const [children, setChildren] = useState(start.steps.some((s) => s.kind === 'children'));
  const [links, setLinks] = useState<LinksStep[]>(
    start.steps.filter((s): s is LinksStep => s.kind === 'links'),
  );
  const [columns, setColumns] = useState<StructureColumn[]>(start.columns);
  const [checks, setChecks] = useState<Map<string, FormulaCheck>>(new Map());
  const [linkTypes, setLinkTypes] = useState<LinkTypeOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [named, setNamed] = useState(true);
  const [refused, setRefused] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    client.linkTypes().then(
      (l) => live && setLinkTypes(l),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client]);

  const groupable = fields.filter((f) => GROUP_TYPES.has(f.type) && !f.multiple);
  const groupName = (field: string) => {
    if ((PLAN_GROUPS as readonly string[]).includes(field)) {
      return t(GROUP_LABELS[field as (typeof PLAN_GROUPS)[number]]);
    }
    const found = groupable.find((f) => customColumn(f.id) === field);
    return found ? fieldName(t, found.name) : field;
  };
  const groupOptions = [...PLAN_GROUPS, ...groupable.map((f) => customColumn(f.id))];
  const sumRefs = [
    ...SUM_REFS,
    ...fields
      .filter((f) => f.type === 'number' || f.type === 'formula')
      .map((f) => customColumn(f.id)),
  ];
  const dayRefs = [
    ...DAY_REFS,
    ...fields
      .filter((f) => f.type === 'date' || f.type === 'datetime')
      .map((f) => customColumn(f.id)),
  ];
  const refsOf = (fn: TotalFn): string[] =>
    fn === 'sum' ? sumRefs : fn === 'min' || fn === 'max' ? [...sumRefs, ...dayRefs] : [];
  const ticketFields = ['key', ...SYSTEM_COLUMNS, ...fields.map((f) => customColumn(f.id))];

  const totals = columns.filter((c) => c.kind === 'total').length;
  const formulas = columns.filter((c) => c.kind === 'formula').length;
  const fullColumns = columns.length >= limits.columns;

  const spec = (): StructureSpec => {
    const steps: StructureStep[] = [
      query.trim() === '' ? { kind: 'insert' } : { kind: 'insert', query: query.trim() },
      ...groups.filter((g) => g !== '').map((field) => ({ kind: 'group' as const, field })),
      ...(children ? [{ kind: 'children' as const }] : []),
      ...links,
    ];
    return { steps, columns };
  };
  /** The step or column a refusal names, by its place in what was sent. */
  const pathOf = (place: string) => refused[`spec.${place}`];

  const check = async (index: number, column: StructureColumn) => {
    if (column.kind !== 'formula') return;
    const result = await client.checkFormula(column.expression, column.output).catch(() => null);
    if (!result) return;
    setChecks((was) => new Map(was).set(`${index}:${column.expression}`, result));
  };

  const save = async () => {
    if (name.trim() === '') {
      setNamed(false);
      setProblem(t('grid.dialog.nameRequired'));
      return;
    }
    setNamed(true);
    setBusy(true);
    setProblem(null);
    setRefused({});
    const body = spec();
    const done: StructureOutcome<StructureSummary> | null = await (structure
      ? client.change(planId, structure.id, {
          name: name.trim(),
          spec: body,
          version: structure.version,
        })
      : client.create(planId, name.trim(), body)
    ).catch(() => null);
    setBusy(false);
    if (!done) {
      setProblem(t('grid.refused.other'));
      return;
    }
    if (!done.ok) {
      setRefused(done.fields);
      if (done.check && !done.check.ok) {
        // The first formula that does not check carries the server's words.
        const at = Object.keys(done.fields)
          .map((k) => /^spec\.columns\.(\d+)\.expression$/.exec(k))
          .find((m) => m !== null);
        const index = at ? Number(at[1]) : -1;
        const column = columns[index];
        if (column?.kind === 'formula') {
          setChecks((was) =>
            new Map(was).set(`${index}:${column.expression}`, done.check as FormulaCheck),
          );
        }
      }
      setProblem(refusal(done));
      return;
    }
    onDone(done.value, structure === null);
  };

  const move = (index: number, by: -1 | 1) =>
    setColumns((was) => {
      const next = [...was];
      const other = index + by;
      if (other < 0 || other >= next.length) return was;
      [next[index], next[other]] = [next[other] as StructureColumn, next[index] as StructureColumn];
      return next;
    });

  const columnTitle = (c: StructureColumn) =>
    c.kind === 'ticket'
      ? nameOf(c.field)
      : c.kind === 'formula'
        ? c.name
        : c.fn === 'count' || c.fn === 'progress'
          ? t(FN_LABELS[c.fn])
          : t('grid.dialog.totalOf', { fn: t(FN_LABELS[c.fn]), field: refName(c.of ?? '') });
  /** A column's check in words: what it shows, and whether it works. */
  const columnCheck = (c: StructureColumn, index: number): { text: string; bad: boolean } => {
    const said = pathOf(`columns.${index}.field`) ?? pathOf(`columns.${index}.of`);
    if (said) return { text: t(FIELD_WORDS[said] ?? 'grid.dialog.problem.other'), bad: true };
    if (c.kind === 'ticket') {
      return {
        text:
          c.field === 'key'
            ? t('grid.dialog.check.key')
            : cellEditor(c.field, fields) && c.field !== 'parent'
              ? t('grid.dialog.check.edits')
              : t('grid.dialog.check.readOnly'),
        bad: false,
      };
    }
    if (c.kind === 'total') {
      const field = refName(c.of ?? '');
      const words: Record<TotalFn, MessageId> = {
        sum: 'grid.dialog.check.sum',
        min: 'grid.dialog.check.min',
        max: 'grid.dialog.check.max',
        count: 'grid.dialog.check.count',
        progress: 'grid.dialog.check.progress',
      };
      return { text: t(words[c.fn], { field }), bad: false };
    }
    const result = checks.get(`${index}:${c.expression}`);
    if (!result) return { text: t('grid.dialog.check.unchecked'), bad: false };
    if (!result.ok)
      return { text: t('grid.dialog.check.wrong', { message: result.error.message }), bad: true };
    return { text: t('grid.dialog.check.ok'), bad: false };
  };

  const linkName = (step: LinksStep) => {
    const type = linkTypes.find((l) => l.id === step.linkTypeId);
    if (!type) return t('grid.dialog.links.gone');
    return step.direction === 'outward' ? type.outward : type.inward;
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('grid.dialog.cancel')}
      focusFirstField
      className="scenario-dialog structure-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>
          {structure
            ? t('grid.dialog.title.edit', { name: structure.name })
            : t('grid.dialog.title.new')}
        </h2>
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('grid.dialog.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={limits.name}
            aria-invalid={!named || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <fieldset className="structure-steps">
          <legend>{t('grid.dialog.steps')}</legend>
          <p className="board-hint">{t('grid.dialog.steps.order')}</p>
          <label className="form-field" htmlFor={`${id}-query`}>
            <span className="form-label">{t('grid.dialog.step.insert')}</span>
            <span className="board-hint" id={`${id}-query-hint`}>
              {t('grid.dialog.step.insertHint')}
            </span>
            <textarea
              id={`${id}-query`}
              rows={2}
              value={query}
              maxLength={limits.query}
              aria-describedby={`${id}-query-hint`}
              aria-invalid={refused['spec.steps.0.query'] ? true : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {[0, 1].map((i) => (
            <label key={i} className="form-field" htmlFor={`${id}-group-${i}`}>
              <span className="form-label">
                {i === 0 ? t('grid.dialog.step.group') : t('grid.dialog.step.groupThen')}
              </span>
              <select
                id={`${id}-group-${i}`}
                value={groups[i] ?? ''}
                disabled={i === 1 && !groups[0]}
                onChange={(event) =>
                  setGroups((was) => {
                    const next = [was[0] ?? '', was[1] ?? ''];
                    next[i] = event.target.value;
                    if (next[0] === '') next[1] = '';
                    return next.filter((g) => g !== '');
                  })
                }
              >
                <option value="">{t('grid.dialog.group.none')}</option>
                {groupOptions.map((g) => (
                  <option key={g} value={g}>
                    {groupName(g)}
                  </option>
                ))}
              </select>
              {pathOf(`steps.${1 + i}.field`) && (
                <span className="form-error">
                  {t(
                    FIELD_WORDS[pathOf(`steps.${1 + i}.field`) as string] ??
                      'grid.dialog.problem.other',
                  )}
                </span>
              )}
            </label>
          ))}
          <div className="form-field form-field-inline">
            <input
              id={`${id}-children`}
              type="checkbox"
              checked={children}
              onChange={(event) => setChildren(event.target.checked)}
            />
            <label htmlFor={`${id}-children`}>{t('grid.dialog.step.children')}</label>
          </div>
          <p className="board-hint">{t('grid.dialog.step.childrenHint')}</p>
          <ul className="structure-list" aria-label={t('grid.dialog.step.links')}>
            {links.map((step, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a step is edited in place by its position
              <li key={i} className="structure-item">
                <label className="form-field" htmlFor={`${id}-link-${i}`}>
                  <span className="form-label">{t('grid.dialog.links.type', { n: i + 1 })}</span>
                  <select
                    id={`${id}-link-${i}`}
                    value={`${step.linkTypeId}:${step.direction}`}
                    onChange={(event) => {
                      const [type, direction] = event.target.value.split(':');
                      setLinks((was) =>
                        was.map((s, j) =>
                          j === i
                            ? {
                                ...s,
                                linkTypeId: Number(type),
                                direction: direction === 'inward' ? 'inward' : 'outward',
                              }
                            : s,
                        ),
                      );
                    }}
                  >
                    {!linkTypes.some((l) => l.id === step.linkTypeId) && (
                      <option value={`${step.linkTypeId}:${step.direction}`}>
                        {linkName(step)}
                      </option>
                    )}
                    {linkTypes.flatMap((l) => [
                      <option key={`${l.id}o`} value={`${l.id}:outward`}>
                        {l.outward}
                      </option>,
                      ...(l.inward === l.outward
                        ? []
                        : [
                            <option key={`${l.id}i`} value={`${l.id}:inward`}>
                              {l.inward}
                            </option>,
                          ]),
                    ])}
                  </select>
                </label>
                <label className="form-field" htmlFor={`${id}-depth-${i}`}>
                  <span className="form-label">{t('grid.dialog.links.depth')}</span>
                  <select
                    id={`${id}-depth-${i}`}
                    value={step.depth}
                    onChange={(event) =>
                      setLinks((was) =>
                        was.map((s, j) =>
                          j === i ? { ...s, depth: Number(event.target.value) as 1 | 2 | 3 } : s,
                        ),
                      )
                    }
                  >
                    {Array.from({ length: limits.linkDepth }, (_, d) => d + 1).map((d) => (
                      <option key={d} value={d}>
                        {t('grid.dialog.links.levels', { count: d })}
                      </option>
                    ))}
                  </select>
                </label>
                {pathOf(`steps.${1 + groups.length + (children ? 1 : 0) + i}.linkTypeId`) && (
                  <p className="form-error">{t('grid.dialog.problem.gone')}</p>
                )}
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setLinks((was) => was.filter((_, j) => j !== i))}
                >
                  {t('grid.dialog.remove')}
                </button>
              </li>
            ))}
          </ul>
          {links.length < limits.steps.links && linkTypes.length > 0 && (
            <button
              type="button"
              className="button-secondary"
              onClick={() =>
                setLinks((was) => [
                  ...was,
                  {
                    kind: 'links',
                    linkTypeId: (linkTypes[0] as LinkTypeOption).id,
                    direction: 'outward',
                    depth: 1,
                  },
                ])
              }
            >
              {t('grid.dialog.links.add')}
            </button>
          )}
          {linkTypes.length === 0 && <p className="board-hint">{t('grid.dialog.links.none')}</p>}
        </fieldset>

        <fieldset className="structure-columns">
          <legend>{t('grid.dialog.columns')}</legend>
          <p className="board-hint">
            {t('grid.dialog.columns.count', {
              columns: columns.length,
              maxColumns: limits.columns,
              totals,
              maxTotals: limits.totals,
              formulas,
              maxFormulas: limits.formulas,
            })}
          </p>
          <ol className="structure-list" aria-label={t('grid.dialog.columns')}>
            {columns.map((c, i) => {
              const said = columnCheck(c, i);
              const title = columnTitle(c);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are edited in place by their position
                <li key={i} className="structure-item">
                  <p className="structure-item-name">{title}</p>
                  {c.kind === 'formula' && (
                    <FormulaFields
                      index={i}
                      column={c}
                      onChange={(next) =>
                        setColumns((was) => was.map((x, j) => (j === i ? next : x)))
                      }
                      onCheck={(next) => void check(i, next)}
                    />
                  )}
                  <p className={said.bad ? 'form-error' : 'board-hint'}>{said.text}</p>
                  <div className="scenario-item-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={t('grid.dialog.up', { name: title })}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      {t('grid.dialog.upShort')}
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={t('grid.dialog.down', { name: title })}
                      disabled={i === columns.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      {t('grid.dialog.downShort')}
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={t('grid.dialog.removeColumn', { name: title })}
                      onClick={() => setColumns((was) => was.filter((_, j) => j !== i))}
                    >
                      {t('grid.dialog.remove')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <AddColumn
            disabled={fullColumns}
            totalsFull={totals >= limits.totals}
            formulasFull={formulas >= limits.formulas}
            ticketFields={ticketFields.filter(
              (f) => !columns.some((c) => c.kind === 'ticket' && c.field === f),
            )}
            fieldName={nameOf}
            refsOf={refsOf}
            refName={refName}
            onAdd={(column) => {
              setColumns((was) => [...was, column]);
              if (column.kind === 'formula') void check(columns.length, column);
            }}
          />
        </fieldset>

        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {structure ? t('grid.dialog.save') : t('grid.dialog.create')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('grid.dialog.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** A formula column's name, expression, output and decimals, checked when it changes. */
function FormulaFields({
  index,
  column,
  onChange,
  onCheck,
}: {
  index: number;
  column: Extract<StructureColumn, { kind: 'formula' }>;
  onChange: (next: Extract<StructureColumn, { kind: 'formula' }>) => void;
  onCheck: (column: StructureColumn) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="structure-formula">
      <label className="form-field" htmlFor={`${id}-name`}>
        <span className="form-label">{t('grid.dialog.formula.name')}</span>
        <input
          id={`${id}-name`}
          value={column.name}
          maxLength={100}
          onChange={(event) => onChange({ ...column, name: event.target.value })}
        />
      </label>
      <label className="form-field" htmlFor={`${id}-expression`}>
        <span className="form-label">{t('grid.dialog.formula.expression', { n: index + 1 })}</span>
        <textarea
          id={`${id}-expression`}
          rows={2}
          value={column.expression}
          onChange={(event) => onChange({ ...column, expression: event.target.value })}
          onBlur={() => onCheck(column)}
        />
      </label>
      <label className="form-field" htmlFor={`${id}-output`}>
        <span className="form-label">{t('grid.dialog.formula.output')}</span>
        <select
          id={`${id}-output`}
          value={column.output}
          onChange={(event) => {
            const next = { ...column, output: event.target.value as OutputType };
            onChange(next);
            onCheck(next);
          }}
        >
          {OUTPUT_TYPES.map((o) => (
            <option key={o} value={o}>
              {t(OUTPUT_LABELS[o])}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field" htmlFor={`${id}-decimals`}>
        <span className="form-label">{t('grid.dialog.formula.decimals')}</span>
        <select
          id={`${id}-decimals`}
          value={column.decimals}
          onChange={(event) => onChange({ ...column, decimals: Number(event.target.value) })}
        >
          {[0, 1, 2, 3].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="button-secondary" onClick={() => onCheck(column)}>
        {t('grid.dialog.formula.check')}
      </button>
    </div>
  );
}

type AddKind = 'ticket' | 'total' | 'formula';

/** Adds a column: a ticket column, a total of the rows below, or a formula. */
function AddColumn({
  disabled,
  totalsFull,
  formulasFull,
  ticketFields,
  fieldName: nameOf,
  refsOf,
  refName,
  onAdd,
}: {
  disabled: boolean;
  totalsFull: boolean;
  formulasFull: boolean;
  ticketFields: string[];
  fieldName: (field: string) => string;
  refsOf: (fn: TotalFn) => string[];
  refName: (ref: string) => string;
  onAdd: (column: StructureColumn) => void;
}) {
  const t = useT();
  const id = useId();
  const [kind, setKind] = useState<AddKind>('ticket');
  const [field, setField] = useState('');
  const [fn, setFn] = useState<TotalFn>('sum');
  const [of, setOf] = useState('');
  const ticket = field || ticketFields[0] || '';
  const refs = refsOf(fn);
  const ref = refs.includes(of) ? of : (refs[0] ?? '');
  const full = disabled || (kind === 'total' && totalsFull) || (kind === 'formula' && formulasFull);
  const add = () => {
    if (full) return;
    if (kind === 'ticket' && ticket) onAdd({ kind: 'ticket', field: ticket });
    if (kind === 'total') {
      onAdd(
        fn === 'count' || fn === 'progress'
          ? { kind: 'total', fn }
          : { kind: 'total', fn, of: ref },
      );
    }
    if (kind === 'formula') {
      onAdd({
        kind: 'formula',
        name: t('grid.dialog.formula.default'),
        expression: 'count(children)',
        output: 'number',
        decimals: 0,
      });
    }
    setField('');
  };
  return (
    <fieldset className="structure-add">
      <legend>{t('grid.dialog.add')}</legend>
      <label className="form-field" htmlFor={`${id}-kind`}>
        <span className="form-label">{t('grid.dialog.add.kind')}</span>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(event) => setKind(event.target.value as AddKind)}
        >
          <option value="ticket">{t('grid.dialog.add.ticket')}</option>
          <option value="total">{t('grid.dialog.add.total')}</option>
          <option value="formula">{t('grid.dialog.add.formula')}</option>
        </select>
      </label>
      {kind === 'ticket' && (
        <label className="form-field" htmlFor={`${id}-field`}>
          <span className="form-label">{t('grid.dialog.add.field')}</span>
          <select id={`${id}-field`} value={ticket} onChange={(e) => setField(e.target.value)}>
            {ticketFields.map((f) => (
              <option key={f} value={f}>
                {nameOf(f)}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'total' && (
        <>
          <label className="form-field" htmlFor={`${id}-fn`}>
            <span className="form-label">{t('grid.dialog.add.fn')}</span>
            <select
              id={`${id}-fn`}
              value={fn}
              onChange={(event) => setFn(event.target.value as TotalFn)}
            >
              {TOTAL_FNS.map((f) => (
                <option key={f} value={f}>
                  {t(FN_LABELS[f])}
                </option>
              ))}
            </select>
          </label>
          {refs.length > 0 && (
            <label className="form-field" htmlFor={`${id}-of`}>
              <span className="form-label">{t('grid.dialog.add.of')}</span>
              <select id={`${id}-of`} value={ref} onChange={(e) => setOf(e.target.value)}>
                {refs.map((r) => (
                  <option key={r} value={r}>
                    {refName(r)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {full && (
        <p className="board-hint">
          {disabled
            ? t('grid.dialog.full.columns')
            : kind === 'total'
              ? t('grid.dialog.full.totals')
              : t('grid.dialog.full.formulas')}
        </p>
      )}
      <button
        type="button"
        className="button-secondary"
        aria-disabled={full || undefined}
        onClick={add}
      >
        {t('grid.dialog.add.button')}
      </button>
    </fieldset>
  );
}

import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';
import {
  type Backlog,
  type BacklogPanels,
  type BacklogTicket,
  type CompleteTarget,
  estimateText,
  type Planned,
  type RankPlace,
  type SprintClient,
  type SprintSection,
  sprintClient,
  type Totals,
} from './client';
import { type PanelTarget, PlanningPanels } from './PlanningPanels';

export interface BacklogPageProps {
  boardId: number;
  client?: SprintClient;
  /** Today, for the default end date of a sprint being started (two weeks later). */
  now?: () => Date;
}

const TWO_WEEKS = 14 * 24 * 3600 * 1000;

/** A section of the page: a sprint's id, or null for the backlog. */
type SectionKey = number | null;

interface Shown {
  key: SectionKey;
  name: string;
  /** Every ticket of the section, in rank order. */
  tickets: BacklogTicket[];
}

/**
 * A Scrum board's backlog (M1-044, M1-047; AGL-008, AGL-009, AGL-010, AGL-011): the active and
 * future sprints as sections, then the backlog, each with its tickets in rank order and the
 * totals by the board's estimation statistic. Sprints are created, started and completed here,
 * with a link to each one's report once started.
 *
 * Planning (M1-047): tickets are selected one by one or a section at a time, and the selection
 * (or one ticket) is dragged to a place in any section, which moves it into that sprint or the
 * backlog and ranks it there as a block, or onto an outcome or a release in the panels. Every
 * drag has a keyboard way: the selection's menus (move to a section, to the top or the bottom,
 * under an outcome, into a release), each ticket's Move menu, and Alt with the up and down arrows
 * to rank one ticket past its neighbour. Choosing a panel item filters the sections to its
 * tickets. Tickets are made inline in any section from a summary.
 */
export function BacklogPage({
  boardId,
  client = sprintClient,
  now = () => new Date(),
}: BacklogPageProps) {
  const t = useT();
  const id = useId();
  const page = useRef<HTMLElement>(null);
  const [data, setData] = useState<Backlog | null>(null);
  const [panels, setPanels] = useState<BacklogPanels | null>(null);
  const [failed, setFailed] = useState(false);
  const [panelsFailed, setPanelsFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState<{ target: PanelTarget; name: string } | null>(null);
  /** The tickets being dragged, and where they would land: before a ticket, or at the end. */
  const [dragging, setDragging] = useState<number[] | null>(null);
  const [dropAt, setDropAt] = useState<{ section: SectionKey; before: number | null } | null>(null);
  /** The ticket to focus again once the backlog is read after a keyboard rank. */
  const refocus = useRef<number | null>(null);

  const load = useCallback(() => {
    client.backlog(boardId).then(
      (d) => {
        setData(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
    client.panels(boardId).then(
      (p) => {
        setPanels(p);
        setPanelsFailed(false);
      },
      () => setPanelsFailed(true),
    );
  }, [client, boardId]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!data) return;
    // Tickets gone from the backlog leave the selection.
    const present = new Set([
      ...data.sprints.flatMap((s) => s.tickets.map((x) => x.id)),
      ...data.backlog.tickets.map((x) => x.id),
    ]);
    setSelected((current) =>
      current.every((x) => present.has(x)) ? current : current.filter((x) => present.has(x)),
    );
    if (refocus.current !== null) {
      page.current
        ?.querySelector<HTMLElement>(`[data-ticket-id="${refocus.current}"] .sprint-ticket-key`)
        ?.focus();
      refocus.current = null;
    }
  }, [data]);

  /** Runs a change, says what it did (or why not) and reads the backlog again. */
  const run = (work: () => Promise<string>, failure: string): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setNotice('');
    return work().then(
      (message) => {
        setBusy(false);
        setNotice(message);
        load();
        return true;
      },
      () => {
        setBusy(false);
        setProblem(failure);
        load();
        return false;
      },
    );
  };
  /** Some tickets of a batch refused (no permission, a rule): say how many. */
  const flag = (outcome: Planned) => {
    if (outcome.refused > 0) setProblem(t('sprints.planned.refused', { count: outcome.refused }));
  };

  const statistic = data?.settings.estimation.statistic ?? 'originalEstimate';
  const totalsText = (totals: Totals) =>
    totals.remaining === undefined
      ? t('sprints.totals', {
          count: totals.tickets,
          estimate: estimateText(t, totals.estimate, statistic),
        })
      : t('sprints.totalsRemaining', {
          count: totals.tickets,
          estimate: estimateText(t, totals.estimate, statistic),
          remaining: estimateText(t, totals.remaining, 'originalEstimate'),
        });

  const sections: Shown[] = data
    ? [
        ...data.sprints.map((s) => ({ key: s.id, name: s.name, tickets: s.tickets })),
        { key: null, name: t('sprints.backlog.title'), tickets: data.backlog.tickets },
      ]
    : [];
  const sectionOf = new Map<number, SectionKey>();
  for (const s of sections) for (const x of s.tickets) sectionOf.set(x.id, s.key);
  const chosen = new Set(selected);
  const inHand = new Set(dragging ?? []);
  /** Tickets in the order the page shows them. */
  const inOrder = (ids: Iterable<number>) => {
    const wanted = new Set(ids);
    return sections.flatMap((s) => s.tickets.map((x) => x.id)).filter((x) => wanted.has(x));
  };
  const nameOf = (key: SectionKey) =>
    sections.find((s) => s.key === key)?.name ?? t('sprints.backlog.title');
  const shownOf = (tickets: BacklogTicket[]) => {
    if (!filter) return tickets;
    const { kind, id: target } = filter.target;
    return tickets.filter((x) =>
      kind === 'outcome' ? x.parentId === target : x.releaseIds.includes(target),
    );
  };

  /** Into a section (a sprint or the backlog), then to a place in the rank as one block. */
  const moveBlock = (ids: number[], target: SectionKey, at: RankPlace | null, message: string) =>
    run(async () => {
      if (target !== null) {
        const outside = ids.filter((x) => sectionOf.get(x) !== target);
        if (outside.length > 0) await client.addTickets(target, outside);
      } else {
        const bySprint = new Map<number, number[]>();
        for (const x of ids) {
          const from = sectionOf.get(x);
          if (from !== null && from !== undefined) {
            bySprint.set(from, [...(bySprint.get(from) ?? []), x]);
          }
        }
        for (const [sprint, list] of bySprint) await client.removeTickets(sprint, list);
      }
      if (at) flag(await client.rank(boardId, ids, at));
      return message;
    }, t('sprints.move.failed'));

  const rankBlock = (ids: number[], at: RankPlace) =>
    run(async () => {
      const outcome = await client.rank(boardId, ids, at);
      flag(outcome);
      return t('sprints.planned.ranked', { count: outcome.done });
    }, t('sprints.move.failed'));

  const toOutcome = (ids: number[], outcome: number | null, name: string) =>
    run(async () => {
      const done = await client.setParent(boardId, ids, outcome);
      flag(done);
      return outcome === null
        ? t('sprints.planned.noParent', { count: done.done })
        : t('sprints.planned.parent', { count: done.done, outcome: name });
    }, t('sprints.planned.failed'));

  const toRelease = (ids: number[], release: number, name: string) =>
    run(async () => {
      const done = await client.addRelease(boardId, ids, release);
      flag(done);
      return t('sprints.planned.release', { count: done.done, release: name });
    }, t('sprints.planned.failed'));

  const create = (section: SectionKey, summary: string) => {
    const track = data?.track;
    if (!track) return Promise.resolve(false);
    return run(async () => {
      const made = await client.createTicket(track.key, summary);
      if (section !== null) await client.addTickets(section, [made.id]);
      return t('sprints.created', { key: made.key });
    }, t('sprints.create.ticketFailed'));
  };

  const toggle = (ticket: number) =>
    setSelected((current) =>
      current.includes(ticket) ? current.filter((x) => x !== ticket) : [...current, ticket],
    );
  const toggleSection = (shown: BacklogTicket[]) => {
    const all = shown.length > 0 && shown.every((x) => chosen.has(x.id));
    setSelected((current) =>
      all
        ? current.filter((x) => !shown.some((s) => s.id === x))
        : [...current, ...shown.map((s) => s.id).filter((x) => !current.includes(x))],
    );
  };

  /** Where a drag over a section would put the block: before the ticket under the pointer's half. */
  function overSection(event: DragEvent, section: SectionKey, shown: BacklogTicket[]) {
    if (dragging === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const over = (event.target as HTMLElement).closest<HTMLElement>('[data-ticket-id]');
    let before: number | null = null;
    if (over) {
      const ticket = Number(over.dataset.ticketId);
      const rect = over.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) before = ticket;
      else before = shown[shown.findIndex((x) => x.id === ticket) + 1]?.id ?? null;
    }
    if (dropAt?.section !== section || dropAt.before !== before) setDropAt({ section, before });
  }

  function endDrag() {
    setDragging(null);
    setDropAt(null);
  }

  /** A drop on a section: the same move as the menus', to the place shown. */
  function dropOnSection(event: DragEvent, section: Shown) {
    event.preventDefault();
    const block = dragging;
    let before = dropAt?.section === section.key ? dropAt.before : null;
    endDrag();
    if (!block || busy) return;
    // Dropped before a ticket of the block itself: before the next one that is not.
    if (before !== null && block.includes(before)) {
      const from = section.tickets.findIndex((x) => x.id === before);
      before = section.tickets.slice(from).find((x) => !block.includes(x.id))?.id ?? null;
    }
    const rest = section.tickets.filter((x) => !block.includes(x.id));
    const at = before === null ? rest.length : rest.findIndex((x) => x.id === before);
    const after = [
      ...rest.slice(0, at).map((x) => x.id),
      ...block,
      ...rest.slice(at).map((x) => x.id),
    ];
    const within = block.every((x) => sectionOf.get(x) === section.key);
    // Dropped where it already was, in that order: nothing to do.
    if (within && after.join() === section.tickets.map((x) => x.id).join()) return;
    const last = rest[rest.length - 1];
    const place: RankPlace | null = before !== null ? { before } : last ? { after: last.id } : null;
    void moveBlock(
      block,
      section.key,
      place,
      within
        ? t('sprints.planned.ranked', { count: block.length })
        : t('sprints.planned.moved', { count: block.length, section: section.name }),
    );
  }

  function dropOnPanel(target: PanelTarget, name: string) {
    const block = dragging;
    endDrag();
    if (!block || busy) return;
    if (target.kind === 'outcome') void toOutcome(block, target.id, name);
    else void toRelease(block, target.id, name);
  }

  /** Alt with an arrow: one ticket past its neighbour in the section, as shown. */
  function onTicketKey(event: KeyboardEvent, ticket: BacklogTicket, shown: BacklogTicket[]) {
    if (!event.altKey || busy) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const up = event.key === 'ArrowUp';
    const neighbour = shown[shown.findIndex((x) => x.id === ticket.id) + (up ? -1 : 1)];
    if (!neighbour) return;
    refocus.current = ticket.id;
    void run(async () => {
      flag(
        await client.rank(
          boardId,
          [ticket.id],
          up ? { before: neighbour.id } : { after: neighbour.id },
        ),
      );
      return t(up ? 'sprints.rank.up' : 'sprints.rank.down', { key: ticket.key });
    }, t('sprints.move.failed'));
  }

  const ticketList = (section: Shown) => {
    const shown = shownOf(section.tickets);
    if (shown.length === 0) return <p className="sprint-empty">{t('sprints.section.empty')}</p>;
    return (
      <ul className="sprint-tickets">
        {shown.map((ticket) => (
          <li
            key={ticket.id}
            className={`sprint-ticket${inHand.has(ticket.id) ? ' is-dragging' : ''}${
              dropAt?.section === section.key && dropAt.before === ticket.id
                ? ' is-drop-before'
                : ''
            }`}
            data-ticket-id={ticket.id}
            data-done={ticket.done || undefined}
            draggable={!busy}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', ticket.key);
              event.dataTransfer.effectAllowed = 'move';
              setDragging(chosen.has(ticket.id) ? inOrder(chosen) : [ticket.id]);
            }}
            onDragEnd={endDrag}
            onKeyDown={(event) => onTicketKey(event, ticket, shown)}
          >
            <input
              type="checkbox"
              className="sprint-ticket-select"
              checked={chosen.has(ticket.id)}
              onChange={() => toggle(ticket.id)}
              aria-label={t('sprints.select.label', { key: ticket.key })}
            />
            <a
              href={`#/tickets/${encodeURIComponent(ticket.key)}`}
              className="sprint-ticket-key"
              aria-describedby={`${id}-hint`}
            >
              {ticket.key}
            </a>
            <span className="sprint-ticket-summary">{ticket.summary}</span>
            <span className="sprint-ticket-status">{ticket.status.name}</span>
            <span className="sprint-ticket-estimate">
              {estimateText(t, ticket.estimate, statistic)}
            </span>
            <label className="sprint-ticket-move">
              <span className="visually-hidden">
                {t('sprints.move.label', { key: ticket.key })}
              </span>
              <select
                value=""
                disabled={busy}
                onChange={(event) => {
                  const to = event.target.value;
                  if (to === '' || (to === 'backlog' && section.key === null)) return;
                  const target = to === 'backlog' ? null : Number(to);
                  void moveBlock(
                    [ticket.id],
                    target,
                    null,
                    t('sprints.planned.moved', { count: 1, section: nameOf(target) }),
                  );
                }}
              >
                <option value="">{t('sprints.move.placeholder')}</option>
                {data?.sprints
                  .filter((s) => s.id !== section.key)
                  .map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
                {section.key !== null && (
                  <option value="backlog">{t('sprints.backlog.title')}</option>
                )}
              </select>
            </label>
          </li>
        ))}
      </ul>
    );
  };

  /** A section's own parts: select-all, its tickets, a drop zone and inline create. */
  const sectionBody = (section: Shown) => {
    const shown = shownOf(section.tickets);
    return {
      selectAll:
        shown.length > 0 ? (
          <label className="sprint-select-all">
            <input
              type="checkbox"
              checked={shown.every((x) => chosen.has(x.id))}
              onChange={() => toggleSection(shown)}
            />
            <span className="visually-hidden">
              {t('sprints.select.all', { section: section.name })}
            </span>
          </label>
        ) : null,
      drop: {
        className: `sprint-section${dropAt?.section === section.key ? ' is-drop-target' : ''}`,
        onDragOver: (event: DragEvent) => overSection(event, section.key, shown),
        onDragLeave: (event: DragEvent) => {
          if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
            setDropAt((current) => (current?.section === section.key ? null : current));
          }
        },
        onDrop: (event: DragEvent) => dropOnSection(event, section),
      },
      list: (
        <>
          {ticketList(section)}
          {data?.track && (
            <InlineCreate
              name={section.name}
              busy={busy}
              onCreate={(summary) => create(section.key, summary)}
            />
          )}
        </>
      ),
    };
  };

  const ids = inOrder(chosen);
  const outcomeName = (outcome: number) => {
    const o = panels?.outcomes.find((x) => x.id === outcome);
    return o ? `${o.key} ${o.summary}` : '';
  };

  return (
    <section ref={page} className="backlog-page" aria-labelledby={`${id}-title`}>
      <div className="board-header">
        <h1 id={`${id}-title`} className="page-title">
          {t('sprints.backlog.pageTitle')}
        </h1>
        <a href={`#/boards/${boardId}`}>{t('sprints.backlog.toBoard')}</a>
      </div>
      {failed && (
        <p className="board-problem" role="alert">
          {t('sprints.backlog.failed')}
        </p>
      )}
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <p className="board-hint" id={`${id}-hint`}>
        {t('sprints.rank.hint')}
      </p>
      <p className="board-hint" role="status">
        {notice}
      </p>
      {data && (
        <div className="backlog-layout">
          <div className="backlog-main">
            {data.mayManage && (
              <div className="form-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const made = await client.create(boardId);
                      return t('sprints.create.done', { name: made.name });
                    }, t('sprints.create.failed'))
                  }
                >
                  {t('sprints.create.submit')}
                </button>
              </div>
            )}
            {ids.length > 0 && (
              <fieldset className="backlog-selection" aria-label={t('sprints.selection.label')}>
                <span>{t('sprints.selection.count', { count: ids.length })}</span>
                <label>
                  <span className="visually-hidden">{t('sprints.selection.move')}</span>
                  <select
                    value=""
                    disabled={busy}
                    onChange={(event) => {
                      const to = event.target.value;
                      if (to === '') return;
                      const target = to === 'backlog' ? null : Number(to);
                      void moveBlock(
                        ids,
                        target,
                        null,
                        t('sprints.planned.moved', { count: ids.length, section: nameOf(target) }),
                      );
                    }}
                  >
                    <option value="">{t('sprints.selection.move')}</option>
                    {data.sprints.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                    <option value="backlog">{t('sprints.backlog.title')}</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => rankBlock(ids, { position: 'top' })}
                >
                  {t('sprints.selection.top')}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => rankBlock(ids, { position: 'bottom' })}
                >
                  {t('sprints.selection.bottom')}
                </button>
                <label>
                  <span className="visually-hidden">{t('sprints.selection.outcome')}</span>
                  <select
                    value=""
                    disabled={busy || !panels}
                    onChange={(event) => {
                      const to = event.target.value;
                      if (to === '') return;
                      const outcome = to === 'none' ? null : Number(to);
                      void toOutcome(ids, outcome, outcome === null ? '' : outcomeName(outcome));
                    }}
                  >
                    <option value="">{t('sprints.selection.outcome')}</option>
                    {panels?.outcomes.map((o) => (
                      <option key={o.id} value={String(o.id)}>
                        {`${o.key} ${o.summary}`}
                      </option>
                    ))}
                    <option value="none">{t('sprints.selection.noOutcome')}</option>
                  </select>
                </label>
                {panels && panels.releases.length > 0 && (
                  <label>
                    <span className="visually-hidden">{t('sprints.selection.release')}</span>
                    <select
                      value=""
                      disabled={busy}
                      onChange={(event) => {
                        const release = panels.releases.find(
                          (r) => String(r.id) === event.target.value,
                        );
                        if (release) void toRelease(ids, release.id, release.name);
                      }}
                    >
                      <option value="">{t('sprints.selection.release')}</option>
                      {panels.releases.map((r) => (
                        <option key={r.id} value={String(r.id)}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button type="button" className="button-secondary" onClick={() => setSelected([])}>
                  {t('sprints.selection.clear')}
                </button>
              </fieldset>
            )}
            {filter && (
              <div className="backlog-filter">
                <span>{t('sprints.filter.showing', { name: filter.name })}</span>
                <button type="button" className="button-secondary" onClick={() => setFilter(null)}>
                  {t('sprints.filter.clear')}
                </button>
              </div>
            )}
            {data.sprints.map((sprint) => {
              const section = sections.find((s) => s.key === sprint.id) as Shown;
              const body = sectionBody(section);
              return (
                <SprintPanel
                  key={sprint.id}
                  section={sprint}
                  sections={data.sprints}
                  manage={data.mayManage}
                  busy={busy}
                  totals={totalsText(sprint.totals)}
                  selectAll={body.selectAll}
                  drop={body.drop}
                  onStart={() =>
                    run(async () => {
                      const end = new Date(now().getTime() + TWO_WEEKS).toISOString();
                      const outcome = await client.start(sprint.id, end);
                      if (!outcome.ok) throw new Error(outcome.code);
                      return t('sprints.start.done', { name: sprint.name });
                    }, t('sprints.start.failed'))
                  }
                  onComplete={(target) =>
                    run(async () => {
                      await client.complete(sprint.id, target);
                      return t('sprints.complete.done', { name: sprint.name });
                    }, t('sprints.complete.failed'))
                  }
                >
                  {body.list}
                </SprintPanel>
              );
            })}
            {(() => {
              const section = sections[sections.length - 1] as Shown;
              const body = sectionBody(section);
              return (
                <section {...body.drop} aria-labelledby={`${id}-backlog`}>
                  <div className="sprint-section-header">
                    {body.selectAll}
                    <h2 id={`${id}-backlog`}>{t('sprints.backlog.title')}</h2>
                    <span className="board-meta">{totalsText(data.backlog.totals)}</span>
                  </div>
                  {body.list}
                </section>
              );
            })()}
            {data.truncated && <p className="board-hint">{t('sprints.backlog.truncated')}</p>}
          </div>
          <PlanningPanels
            panels={panels}
            failed={panelsFailed}
            filter={filter?.target ?? null}
            onFilter={(target, name) => setFilter(target ? { target, name } : null)}
            dragging={dragging !== null}
            onDrop={dropOnPanel}
          />
        </div>
      )}
    </section>
  );
}

interface InlineCreateProps {
  name: string;
  busy: boolean;
  /** Makes the ticket; true when it was made, so the field empties. */
  onCreate: (summary: string) => Promise<boolean>;
}

/** A ticket made in a section from its summary alone (AGL-008 inline create). */
function InlineCreate({ name, busy, onCreate }: InlineCreateProps) {
  const t = useT();
  const id = useId();
  const [summary, setSummary] = useState('');
  return (
    <form
      className="backlog-create"
      onSubmit={(event) => {
        event.preventDefault();
        const text = summary.trim();
        if (text === '') return;
        void onCreate(text).then((made) => {
          if (made) setSummary('');
        });
      }}
    >
      <label htmlFor={id} className="visually-hidden">
        {t('sprints.create.label', { section: name })}
      </label>
      <input
        id={id}
        type="text"
        value={summary}
        maxLength={255}
        placeholder={t('sprints.create.placeholder')}
        onChange={(event) => setSummary(event.target.value)}
      />
      <button type="submit" className="button-secondary" disabled={busy || summary.trim() === ''}>
        {t('sprints.create.ticket')}
      </button>
    </form>
  );
}

interface SprintPanelProps {
  section: SprintSection;
  sections: SprintSection[];
  manage: boolean;
  busy: boolean;
  totals: string;
  selectAll: React.ReactNode;
  /** The section's drop handlers and class (M1-047). */
  drop: {
    className: string;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  onStart: () => void;
  onComplete: (target: CompleteTarget) => void;
  children: React.ReactNode;
}

function SprintPanel({
  section,
  sections,
  manage,
  busy,
  totals,
  selectAll,
  drop,
  onStart,
  onComplete,
  children,
}: SprintPanelProps) {
  const t = useT();
  const id = useId();
  const [target, setTarget] = useState('backlog');
  const futures = sections.filter((s) => s.state === 'future' && s.id !== section.id);
  const chosen = (): CompleteTarget =>
    target === 'backlog'
      ? { type: 'backlog' }
      : target === 'new'
        ? { type: 'new' }
        : { type: 'sprint', sprintId: Number(target) };
  return (
    <section {...drop} aria-labelledby={`${id}-name`}>
      <div className="sprint-section-header">
        {selectAll}
        <h2 id={`${id}-name`}>{section.name}</h2>
        <span className="sprint-state">
          {t(section.state === 'active' ? 'sprints.state.active' : 'sprints.state.future')}
        </span>
        <span className="board-meta">{totals}</span>
        {section.state === 'active' && (
          <a href={`#/boards/${section.boardId}/sprints/${section.id}/report`}>
            {t('sprints.report.link')}
          </a>
        )}
      </div>
      {section.goal && <p className="board-hint">{section.goal}</p>}
      {manage && section.state === 'future' && (
        <div className="form-actions">
          <button type="button" className="button-primary" disabled={busy} onClick={onStart}>
            {t('sprints.start.submit')}
          </button>
        </div>
      )}
      {manage && section.state === 'active' && (
        <div className="sprint-complete">
          <label htmlFor={`${id}-target`} className="form-label">
            {t('sprints.complete.target')}
          </label>
          <select
            id={`${id}-target`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="backlog">{t('sprints.backlog.title')}</option>
            {futures.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
            <option value="new">{t('sprints.complete.newSprint')}</option>
          </select>
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => onComplete(chosen())}
          >
            {t('sprints.complete.submit')}
          </button>
        </div>
      )}
      {children}
    </section>
  );
}

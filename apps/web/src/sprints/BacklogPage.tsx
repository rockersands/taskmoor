import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { MoveMenu, type MoveMenuItem } from '../shell/MoveMenu';
import { playMotion } from '../shell/motion';
import { PageHeader } from '../shell/PageHeader';
import { followPointerDrag } from '../shell/pointerDrag';
import { PriorityIcon, TypeIcon } from '../shell/TicketIcons';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { useTrackSections } from '../tracks/trackSections';
import { CompleteTargetSelect, completeRefusal, targetOf } from './CompleteSprint';
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

/** Where a drag would land: before a ticket of a section or at its end, or on a panel's item. */
type Drop =
  | { kind: 'section'; section: SectionKey; before: number | null }
  | { kind: 'panel'; target: PanelTarget; name: string };

const sameDrop = (a: Drop | null, b: Drop | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    (a.kind === 'section' && b.kind === 'section'
      ? a.section === b.section && a.before === b.before
      : a.kind === 'panel' &&
        b.kind === 'panel' &&
        a.target.kind === b.target.kind &&
        a.target.id === b.target.id));

/** A press on these is theirs: a mouse drags a row from anywhere else on it. */
const OWN_PRESS = 'button, input, select, textarea, label';

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
 * under an outcome, into a release), each ticket's grip menu (up, down, top, bottom, another
 * section), and Alt with the up and down arrows to rank one ticket past its neighbour. Choosing a
 * panel item filters the sections to its tickets. Tickets are made inline in any section from a
 * summary.
 *
 * Drags use pointer events (T-162; ADR-114, section 12): a mouse drags a row from anywhere but
 * its controls, and a finger or a mouse drags it by its grip. The section and the place it would
 * land are marked as on the board, the page says what is in hand, Escape cancels, and the
 * server's rank and sprint rules judge every drop as they judge the menus.
 */
export function BacklogPage({
  boardId,
  client = sprintClient,
  now = () => new Date(),
}: BacklogPageProps) {
  const t = useT();
  const id = useId();
  const page = useRef<HTMLElement>(null);
  /**
   * A track with its sprints turned off starts none (AGL-010; ADR-116): the page offers no Start
   * and says why, as the track's other pages hide what needs sprints. Unknown outside a track.
   */
  const sprintsOff = useTrackSections()?.sprints === false;
  const [data, setData] = useState<Backlog | null>(null);
  const [panels, setPanels] = useState<BacklogPanels | null>(null);
  const [failed, setFailed] = useState(false);
  const [panelsFailed, setPanelsFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState<{ target: PanelTarget; name: string } | null>(null);
  /** The tickets being dragged, and where they would land: a place in a section, or a panel. */
  const [dragging, setDragging] = useState<number[] | null>(null);
  const [over, setOver] = useState<Drop | null>(null);
  /** Where the pointer is while dragging, for the label that follows it. */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  /** What to focus again once the backlog is read after a keyboard move: a ticket's key or grip. */
  const refocus = useRef<{ id: number; part: 'key' | 'grip' } | null>(null);
  /** The ticket a drop has just placed: it settles in once the backlog is read again. */
  const landed = useRef<number | null>(null);
  /** Stops following a drag, should the page go while one is under way. */
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

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
  useTicketChanges(load);

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
      const { id: ticket, part } = refocus.current;
      page.current
        ?.querySelector<HTMLElement>(
          part === 'grip'
            ? `[data-handle="ticket-${ticket}"]`
            : `[data-ticket-id="${ticket}"] .sprint-ticket-key`,
        )
        ?.focus();
      refocus.current = null;
    }
    if (landed.current !== null) {
      const row = page.current?.querySelector(`[data-ticket-id="${landed.current}"]`);
      // Only the ticket that has just dropped moves, as on the board.
      if (row) playMotion(row, 'motion-drop');
      landed.current = null;
    }
  }, [data]);

  /** Runs a change, says what it did (or why not) and reads the backlog again. */
  const run = (
    work: () => Promise<string>,
    failure: string | ((error: unknown) => string),
  ): Promise<boolean> => {
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
      (error: unknown) => {
        setBusy(false);
        setProblem(typeof failure === 'string' ? failure : failure(error));
        load();
        return false;
      },
    );
  };
  /** A track whose sprints are turned off starts none (AGL-010); other refusals say the usual. */
  const startRefusal = (error: unknown) =>
    t(
      error instanceof Error && error.message === 'sprints_off'
        ? 'sprints.start.sprintsOff'
        : 'sprints.start.failed',
    );
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
  const ticketOf = new Map<number, BacklogTicket>();
  for (const s of sections) {
    for (const x of s.tickets) {
      sectionOf.set(x.id, s.key);
      ticketOf.set(x.id, x);
    }
  }
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

  /** What is under the pointer, as a place a dragged block may land (T-162). */
  function dropAt(x: number, y: number): Drop | null {
    const element = document.elementFromPoint?.(x, y);
    if (!element) return null;
    const item = element.closest<HTMLElement>('[data-drop-panel]');
    if (item) {
      return {
        kind: 'panel',
        target: {
          kind: item.dataset.dropPanel === 'release' ? 'release' : 'outcome',
          id: Number(item.dataset.targetId),
        },
        name: item.dataset.name ?? '',
      };
    }
    const holder = element.closest<HTMLElement>('[data-drop-section]');
    if (!holder) return null;
    const key =
      holder.dataset.dropSection === 'backlog' ? null : Number(holder.dataset.dropSection);
    const section = sections.find((s) => s.key === key);
    if (!section) return null;
    // Before the ticket under the pointer's upper half, or the one after; anywhere else, the end.
    const row = element.closest<HTMLElement>('[data-ticket-id]');
    let before: number | null = null;
    if (row && holder.contains(row)) {
      const shown = shownOf(section.tickets);
      const ticket = Number(row.dataset.ticketId);
      const rect = row.getBoundingClientRect();
      before =
        y < rect.top + rect.height / 2
          ? ticket
          : (shown[shown.findIndex((x) => x.id === ticket) + 1]?.id ?? null);
    }
    return { kind: 'section', section: key, before };
  }

  function endDrag() {
    setDragging(null);
    setOver(null);
    setGhost(null);
  }

  /** A drop on a section: the same move as the menus', to the place shown. */
  function dropOnSection(block: number[], section: Shown, at: number | null) {
    let before = at;
    // Dropped before a ticket of the block itself: before the next one that is not.
    if (before !== null && block.includes(before)) {
      const from = section.tickets.findIndex((x) => x.id === before);
      before = section.tickets.slice(from).find((x) => !block.includes(x.id))?.id ?? null;
    }
    const rest = section.tickets.filter((x) => !block.includes(x.id));
    const place = before === null ? rest.length : rest.findIndex((x) => x.id === before);
    const after = [
      ...rest.slice(0, place).map((x) => x.id),
      ...block,
      ...rest.slice(place).map((x) => x.id),
    ];
    const within = block.every((x) => sectionOf.get(x) === section.key);
    // Dropped where it already was, in that order: nothing to ask of the server.
    if (within && after.join() === section.tickets.map((x) => x.id).join()) {
      setNotice(
        t('sprints.drag.cancelled', {
          count: block.length,
          key: ticketOf.get(block[0] as number)?.key ?? '',
        }),
      );
      return;
    }
    const last = rest[rest.length - 1];
    const rank: RankPlace | null = before !== null ? { before } : last ? { after: last.id } : null;
    landed.current = block[0] ?? null;
    void moveBlock(
      block,
      section.key,
      rank,
      within
        ? t('sprints.planned.ranked', { count: block.length })
        : t('sprints.planned.moved', { count: block.length, section: section.name }),
    );
  }

  /** Where a drop lands: a place in a section, or the outcome or release of a panel. */
  function dropOn(block: number[], to: Drop) {
    if (busy) return;
    if (to.kind === 'panel') {
      if (to.target.kind === 'outcome') void toOutcome(block, to.target.id, to.name);
      else void toRelease(block, to.target.id, to.name);
      return;
    }
    const section = sections.find((s) => s.key === to.section);
    if (section) dropOnSection(block, section, to.before);
  }

  // A drag outlives the drawing it began in: it asks the latest one where it is and what to do.
  const live = useRef({ dropAt, dropOn });
  live.current = { dropAt, dropOn };

  /**
   * A press on a row (by mouse) or on its grip (by anything) that may become a drag. The
   * selection moves as one block when the ticket is part of it; otherwise the ticket alone.
   */
  function beginDrag(event: ReactPointerEvent, ticket: BacklogTicket) {
    if (busy || stopDrag.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const block = chosen.has(ticket.id) ? inOrder(chosen) : [ticket.id];
    const words = { count: block.length, key: ticket.key };
    stopDrag.current = followPointerDrag(event, {
      start: (x, y) => {
        setDragging(block);
        setGhost({ x, y });
        setProblem(null);
        setNotice(t('sprints.drag.start', words));
      },
      move: (x, y) => {
        setGhost({ x, y });
        const to = live.current.dropAt(x, y);
        setOver((current) => (sameDrop(current, to) ? current : to));
      },
      drop: (x, y) => {
        const to = live.current.dropAt(x, y);
        endDrag();
        if (to) live.current.dropOn(block, to);
        else setNotice(t('sprints.drag.cancelled', words));
      },
      cancel: () => {
        endDrag();
        setNotice(t('sprints.drag.cancelled', words));
      },
      end: () => {
        stopDrag.current = null;
      },
    });
  }

  /** One ticket past its neighbour in its section as shown, or to an end of the rank. */
  function rankOne(
    ticket: BacklogTicket,
    shown: BacklogTicket[],
    to: 'up' | 'down' | 'top' | 'bottom',
    part: 'key' | 'grip',
  ) {
    if (busy) return;
    const at = shown.findIndex((x) => x.id === ticket.id);
    let place: RankPlace;
    if (to === 'top' || to === 'bottom') {
      place = { position: to };
    } else {
      const neighbour = shown[at + (to === 'up' ? -1 : 1)];
      if (!neighbour) return;
      place = to === 'up' ? { before: neighbour.id } : { after: neighbour.id };
    }
    refocus.current = { id: ticket.id, part };
    void run(async () => {
      flag(await client.rank(boardId, [ticket.id], place));
      return t(`sprints.rank.${to}`, { key: ticket.key });
    }, t('sprints.move.failed'));
  }

  /** Alt with an arrow: one ticket past its neighbour in the section, as shown. */
  function onTicketKey(event: KeyboardEvent, ticket: BacklogTicket, shown: BacklogTicket[]) {
    if (!event.altKey || busy) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const onGrip = (event.target as HTMLElement).closest('[data-handle]') !== null;
    rankOne(ticket, shown, event.key === 'ArrowUp' ? 'up' : 'down', onGrip ? 'grip' : 'key');
  }

  /** A ticket's grip menu: every move a drag makes, one at a time (T-162). */
  function gripItems(ticket: BacklogTicket, section: Shown, shown: BacklogTicket[]) {
    const at = shown.findIndex((x) => x.id === ticket.id);
    const items: MoveMenuItem[] = [];
    const rank = (to: 'up' | 'down' | 'top' | 'bottom') => () => rankOne(ticket, shown, to, 'grip');
    if (at > 0) {
      items.push(
        { key: 'up', label: t('sprints.grip.up'), onSelect: rank('up') },
        { key: 'top', label: t('sprints.grip.top'), onSelect: rank('top') },
      );
    }
    if (at < shown.length - 1) {
      items.push(
        { key: 'down', label: t('sprints.grip.down'), onSelect: rank('down') },
        { key: 'bottom', label: t('sprints.grip.bottom'), onSelect: rank('bottom') },
      );
    }
    for (const other of sections) {
      if (other.key === section.key) continue;
      items.push({
        key: `to-${other.key ?? 'backlog'}`,
        label: t('sprints.grip.to', { section: other.name }),
        onSelect: () => {
          if (busy) return;
          refocus.current = { id: ticket.id, part: 'grip' };
          void moveBlock(
            [ticket.id],
            other.key,
            null,
            t('sprints.planned.moved', { count: 1, section: other.name }),
          );
        },
      });
    }
    return items;
  }

  const ticketList = (section: Shown) => {
    const shown = shownOf(section.tickets);
    if (shown.length === 0) return <EmptyState compact title={t('sprints.section.empty')} />;
    return (
      <ul className="sprint-tickets">
        {shown.map((ticket) => (
          <li
            key={ticket.id}
            className={`sprint-ticket${inHand.has(ticket.id) ? ' is-dragging' : ''}${
              over?.kind === 'section' && over.section === section.key && over.before === ticket.id
                ? ' is-drop-before'
                : ''
            }`}
            data-ticket-id={ticket.id}
            data-done={ticket.done || undefined}
            onPointerDown={(event) => {
              // A mouse drags the row from anywhere but its controls; a finger, by the grip.
              if (event.pointerType !== 'mouse') return;
              if ((event.target as HTMLElement).closest(OWN_PRESS)) return;
              beginDrag(event, ticket);
            }}
            onKeyDown={(event) => onTicketKey(event, ticket, shown)}
          >
            <MoveMenu
              className="sprint-ticket-grip"
              label={t('sprints.grip.label', { key: ticket.key })}
              handle={`ticket-${ticket.id}`}
              items={gripItems(ticket, section, shown)}
              onDragStart={(event) => beginDrag(event, ticket)}
            />
            <input
              type="checkbox"
              className="sprint-ticket-select"
              checked={chosen.has(ticket.id)}
              onChange={() => toggle(ticket.id)}
              aria-label={t('sprints.select.label', { key: ticket.key })}
            />
            <span className="ticket-icons">
              <TypeIcon name={ticket.type} icon={ticket.typeIcon} />
              {ticket.priority && (
                <PriorityIcon name={ticket.priority.name} level={ticket.priority.level} />
              )}
            </span>
            <a
              href={routeHref(`#/tickets/${encodeURIComponent(ticket.key)}`)}
              className="sprint-ticket-key"
              aria-describedby={`${id}-hint`}
              // The row is dragged, not the link's address.
              draggable={false}
            >
              {ticket.key}
            </a>
            <span className="sprint-ticket-summary">{ticket.summary}</span>
            <span className="sprint-ticket-status">{ticket.status.name}</span>
            <span className="sprint-ticket-estimate">
              {estimateText(t, ticket.estimate, statistic)}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  /** A section's own parts: select-all, its tickets, its drop place and inline create. */
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
        className: `glass-card sprint-section${
          over?.kind === 'section' && over.section === section.key ? ' is-drop-target' : ''
        }`,
        'data-drop-section': section.key === null ? 'backlog' : String(section.key),
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
  const first = dragging?.[0] !== undefined ? ticketOf.get(dragging[0]) : undefined;

  return (
    <section ref={page} className="page backlog-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('sprints.backlog.pageTitle')}
        purpose={t('purpose.backlog')}
        actions={
          <a className="button-quiet" href={routeHref(`#/boards/${boardId}`)}>
            {t('sprints.backlog.toBoard')}
          </a>
        }
      />
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
          <div className="backlog-main" data-tutorial="backlog">
            {data.mayManage && (
              <div className="form-actions">
                <button
                  type="button"
                  className="button-secondary"
                  data-tutorial="sprint-create"
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
            {data.mayManage && sprintsOff && (
              <p className="board-hint">{t('sprints.start.sprintsOff')}</p>
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
                  canStart={!sprintsOff}
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
                    }, startRefusal)
                  }
                  onComplete={(target) =>
                    run(
                      async () => {
                        await client.complete(sprint.id, target);
                        return t('sprints.complete.done', { name: sprint.name });
                      },
                      (error) => completeRefusal(t, error),
                    )
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
            over={over?.kind === 'panel' ? over.target : null}
          />
        </div>
      )}
      {dragging && ghost && (
        <div
          className="drag-ghost"
          aria-hidden="true"
          style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
        >
          {dragging.length === 1 && first
            ? `${first.key} ${first.summary}`
            : t('sprints.drag.many', { count: dragging.length })}
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
  /** False while the track's sprints are turned off: a planned sprint cannot start. */
  canStart: boolean;
  busy: boolean;
  totals: string;
  selectAll: React.ReactNode;
  /** The section as a drop place: its class while a drag is over it, and its key (T-162). */
  drop: {
    className: string;
    'data-drop-section': string;
  };
  onStart: () => void;
  onComplete: (target: CompleteTarget) => void;
  children: React.ReactNode;
}

function SprintPanel({
  section,
  sections,
  manage,
  canStart,
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
  return (
    <section {...drop} aria-labelledby={`${id}-name`}>
      <div className="sprint-section-header">
        {selectAll}
        <h2 id={`${id}-name`}>{section.name}</h2>
        <span className="badge badge-accent sprint-state">
          {t(section.state === 'active' ? 'sprints.state.active' : 'sprints.state.future')}
        </span>
        <span className="board-meta">{totals}</span>
        {section.state === 'active' && (
          <a href={routeHref(`#/boards/${section.boardId}/sprints/${section.id}/report`)}>
            {t('sprints.report.link')}
          </a>
        )}
      </div>
      {section.goal && <p className="board-hint">{section.goal}</p>}
      {manage && canStart && section.state === 'future' && (
        <div className="form-actions">
          <button
            type="button"
            className="button-primary"
            data-tutorial="sprint-start"
            disabled={busy}
            onClick={onStart}
          >
            {t('sprints.start.submit')}
          </button>
        </div>
      )}
      {manage && section.state === 'active' && (
        <div className="sprint-complete">
          <label htmlFor={`${id}-target`} className="form-label">
            {t('sprints.complete.target')}
          </label>
          <CompleteTargetSelect
            id={`${id}-target`}
            value={target}
            onChange={setTarget}
            futures={futures}
          />
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => onComplete(targetOf(target))}
          >
            {t('sprints.complete.submit')}
          </button>
        </div>
      )}
      {children}
    </section>
  );
}

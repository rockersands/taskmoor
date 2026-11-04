import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { ChevronDownIcon } from '../shell/icons';
import { ModalDialog } from '../shell/ModalDialog';
import { leaveMotion } from '../shell/motion';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { useMenuButton } from '../shell/useMenuButton';
import type { TrackListItem } from '../tracks/client';
import { trackHref } from '../tracks/TrackLayout';
import type { GroupTrack, TrackGroup, TrackGroupClient } from './client';
import { GroupNameDialog } from './GroupNameDialog';
import { ShareGroupDialog } from './ShareGroupDialog';

export interface TrackArrangementProps {
  /** Every track the person sees, in the directory's order. */
  tracks: TrackListItem[];
  /** The person's groups and those shared with them, in their order. */
  groups: TrackGroup[];
  client: TrackGroupClient;
  /** The arrangement after a change, as the server answered it. */
  onGroups: (groups: TrackGroup[]) => void;
}

/** What is being dragged. */
type DragItem =
  | { kind: 'track'; trackId: number; name: string; groupId: number | null }
  | { kind: 'group'; groupId: number; name: string };

/** Where a drop would land: on a track, on a group, or among the tracks in no group. */
type Drop =
  | { kind: 'track'; trackId: number; groupId: number | null }
  | { kind: 'group'; groupId: number }
  | { kind: 'loose' };

/** How far a pointer moves before a press on a handle becomes a drag, in pixels. */
const DRAG_START = 6;
/** How many small squares a minimized group shows. */
const SQUARES = 9;

/** Six dots: the handle's grip, drawn here. */
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {[4, 8, 12].map((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />),
      )}
    </svg>
  );
}

/** One move in a grip's menu; the key is stable, since two groups may share a name. */
interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

interface MoveMenuProps {
  label: string;
  /** Which element this handle moves, so focus can find it again after a change. */
  handle: string;
  items: MenuItem[];
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /** Alt and an arrow key: -1 earlier, 1 later. */
  onStep?: (direction: -1 | 1) => void;
  /** True right after this handle's own drag, whose click must not open the menu. */
  justDragged: (handle: string) => boolean;
}

/**
 * A card's or group's handle: drag it with a mouse or a finger, or press it for a menu of the
 * same moves; Alt and the arrow keys move what it belongs to. Every drag has this keyboard path.
 */
function MoveMenu({ label, handle, items, onDragStart, onStep, justDragged }: MoveMenuProps) {
  const { open, openMenu, close, container, button, menu, buttonId, menuId, ...keys } =
    useMenuButton();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : 0;
    if (event.altKey && step !== 0) {
      event.preventDefault();
      onStep?.(step);
      return;
    }
    keys.onButtonKeyDown(event);
  };
  return (
    <div className="track-move" ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="track-move-handle"
        data-handle={handle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={(event) => {
          // A pointer's click right after a drag is the drag's; Enter or Space never is.
          if (event.detail > 0 && justDragged(handle)) return;
          if (open) close(false);
          else openMenu(true);
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onDragStart}
      >
        <GripIcon />
      </button>
      {open && (
        <div ref={leaveMotion} className="user-menu-popup track-move-popup">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={keys.onMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.key}
                role="menuitem"
                tabIndex={-1}
                type="button"
                className="user-menu-item"
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Tracks page arranged in the person's groups (CORE-034; ADR-121): open groups are glass
 * bubbles holding their tracks, minimized ones the size of one track card with a count and small
 * glass squares; tracks in no group follow. Drag a track onto another to make a group of the two,
 * onto a group to put it there, or among the tracks in no group to take it out; drag a group onto
 * another to take its place. Pointer events carry the drags, so a mouse and a finger work alike,
 * and every drag is also in the handle's menu and on Alt and the arrow keys.
 */
export function TrackArrangement({ tracks, groups, client, onGroups }: TrackArrangementProps) {
  const t = useT();
  const id = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [over, setOver] = useState<Drop | null>(null);
  const [naming, setNaming] = useState<
    { mode: 'new'; trackIds: number[] } | { mode: 'rename'; group: TrackGroup } | null
  >(null);
  const [sharing, setSharing] = useState<{ mode: 'share' | 'setOn'; group: TrackGroup } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<TrackGroup | null>(null);
  const [leaving, setLeaving] = useState<TrackGroup | null>(null);
  const [said, setSaid] = useState('');
  const saying = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * Tells screen readers what changed. The status empties first and takes the words a moment
   * later, so the same words twice in a row are announced twice.
   */
  const say = (words: string) => {
    clearTimeout(saying.current);
    setSaid('');
    saying.current = setTimeout(() => setSaid(words), 60);
  };
  useEffect(() => () => clearTimeout(saying.current), []);
  const [problem, setProblem] = useState<string | null>(null);
  /** The handle to focus once the change shows: what was moved stays under the keyboard. */
  const pendingFocus = useRef<((next: TrackGroup[]) => string | null) | null>(null);
  /** The handle a drag last ended on, and when: the click it ends with is the drag's. */
  const dragEnded = useRef({ handle: '', at: Number.NEGATIVE_INFINITY });
  const live = useRef(groups);
  live.current = groups;

  const mine = groups.filter((g) => g.mine);
  const groupOf = new Map<number, TrackGroup>();
  for (const g of mine) for (const track of g.tracks) groupOf.set(track.id, g);
  const loose = tracks.filter((track) => !groupOf.has(track.id));
  const owners = new Map(tracks.map((track) => [track.id, track.owner]));

  useEffect(() => {
    const focusFor = pendingFocus.current;
    if (!focusFor) return;
    pendingFocus.current = null;
    const handle = focusFor(groups);
    if (handle) document.querySelector<HTMLElement>(`[data-handle="${handle}"]`)?.focus();
  }, [groups]);

  /** Where a track's handle is after a change: its card, or its group if that is minimized. */
  const trackHandle = (trackId: number) => (next: TrackGroup[]) => {
    const holder = next.find((g) => g.mine && g.tracks.some((tr) => tr.id === trackId));
    return holder?.minimized ? `group-${holder.id}` : `track-${trackId}`;
  };

  const run = async (
    work: () => Promise<TrackGroup[]>,
    announce: (next: TrackGroup[]) => string,
    focus?: (next: TrackGroup[]) => string | null,
  ) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await work();
      pendingFocus.current = focus ?? null;
      onGroups(next);
      say(announce(next));
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.code === 'last_track_admin'
          ? t('trackGroups.lastAdmin')
          : t('trackGroups.changeFailed'),
      );
      // Refused as out of date (a group shared or taken back since the page loaded, say): the
      // arrangement is read again, so the next try starts from what the server has.
      if (error instanceof ApiError && (error.status === 400 || error.status === 404)) {
        client.layout().then(onGroups, () => {});
      }
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (trackId: number) =>
    tracks.find((tr) => tr.id === trackId)?.name ??
    groups.flatMap((g) => g.tracks).find((tr) => tr.id === trackId)?.name ??
    '';

  const placeTrack = (groupId: number, trackId: number, position?: number) =>
    run(
      () => client.place(groupId, trackId, position),
      (next) => {
        const group = next.find((g) => g.id === groupId);
        const tracksIn = group?.tracks ?? [];
        return t('trackGroups.announce.trackPlace', {
          track: nameOf(trackId),
          group: group?.name ?? '',
          position: tracksIn.findIndex((tr) => tr.id === trackId) + 1,
          count: tracksIn.length,
        });
      },
      trackHandle(trackId),
    );

  const takeOut = (groupId: number, trackId: number) =>
    run(
      () => client.takeOut(groupId, trackId),
      () => t('trackGroups.announce.takenOut', { track: nameOf(trackId) }),
      () => `track-${trackId}`,
    );

  const makeGroup = (name: string, trackIds: number[]) => {
    const before = new Set(live.current.map((g) => g.id));
    const made = (next: TrackGroup[]) => next.find((g) => !before.has(g.id));
    return run(
      () => client.create(name, trackIds),
      () => t('trackGroups.announce.created', { name }),
      (next) => {
        const group = made(next);
        return group ? `group-${group.id}` : null;
      },
    );
  };

  const reorderGroups = (groupId: number, at: number) => {
    const ids = live.current.map((g) => g.id).filter((g) => g !== groupId);
    ids.splice(Math.max(0, Math.min(at, ids.length)), 0, groupId);
    const name = live.current.find((g) => g.id === groupId)?.name ?? '';
    return run(
      () => client.order(ids),
      (next) =>
        t('trackGroups.announce.groupPlace', {
          name,
          position: next.findIndex((g) => g.id === groupId) + 1,
          count: next.length,
        }),
      () => `group-${groupId}`,
    );
  };

  /** A track one place earlier or later in its group (Alt and the arrow keys, or its menu). */
  const stepTrack = (group: TrackGroup, trackId: number, direction: -1 | 1) => {
    const index = group.tracks.findIndex((tr) => tr.id === trackId);
    const to = index + direction;
    // One move at a time: a key held down waits for the last move to show.
    if (busy || index < 0 || to < 0 || to >= group.tracks.length) return;
    void placeTrack(group.id, trackId, to);
  };

  const stepGroup = (groupId: number, direction: -1 | 1) => {
    const index = groups.findIndex((g) => g.id === groupId);
    const to = index + direction;
    if (busy || index < 0 || to < 0 || to >= groups.length) return;
    void reorderGroups(groupId, to);
  };

  /** What is under the pointer, as a place this drag may land. */
  function dropAt(x: number, y: number, item: DragItem): Drop | null {
    const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-drop]');
    if (!element) return null;
    const own = new Set(live.current.filter((g) => g.mine).map((g) => g.id));
    if (item.kind === 'group') {
      const holder = element.closest<HTMLElement>('[data-drop="group"]');
      const groupId = Number(holder?.dataset.groupId);
      return groupId && groupId !== item.groupId ? { kind: 'group', groupId } : null;
    }
    const kind = element.dataset.drop;
    if (kind === 'track') {
      const trackId = Number(element.dataset.trackId);
      const groupId = element.dataset.groupId ? Number(element.dataset.groupId) : null;
      if (trackId === item.trackId || (groupId !== null && !own.has(groupId))) return null;
      return { kind: 'track', trackId, groupId };
    }
    if (kind === 'group') {
      const groupId = Number(element.dataset.groupId);
      return own.has(groupId) && groupId !== item.groupId ? { kind: 'group', groupId } : null;
    }
    return kind === 'loose' && item.groupId !== null ? { kind: 'loose' } : null;
  }

  function dropOn(item: DragItem, to: Drop) {
    const all = live.current;
    if (item.kind === 'group') {
      if (to.kind !== 'group') return;
      // It takes the target's place: after it when coming from before, before it otherwise.
      void reorderGroups(
        item.groupId,
        all.findIndex((g) => g.id === to.groupId),
      );
      return;
    }
    if (to.kind === 'loose') {
      if (item.groupId !== null) void takeOut(item.groupId, item.trackId);
    } else if (to.kind === 'group') {
      void placeTrack(to.groupId, item.trackId);
    } else if (to.groupId === null) {
      // Two tracks in no group make a new one, named first.
      setNaming({ mode: 'new', trackIds: [to.trackId, item.trackId] });
    } else {
      const group = all.find((g) => g.id === to.groupId);
      if (!group) return;
      const ids = group.tracks.map((tr) => tr.id);
      const from = ids.indexOf(item.trackId);
      const target = ids.indexOf(to.trackId);
      const position =
        from >= 0 && from < target
          ? target
          : ids.filter((x) => x !== item.trackId).indexOf(to.trackId);
      void placeTrack(group.id, item.trackId, position);
    }
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, item: DragItem) {
    if (busy || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let moving = false;
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!moving) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START) return;
        moving = true;
        setDrag(item);
      }
      e.preventDefault();
      setGhost({ x: e.clientX, y: e.clientY });
      setOver(dropAt(e.clientX, e.clientY, item));
    };
    const finish = (e: PointerEvent, landed: boolean) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (!moving) return;
      dragEnded.current = {
        handle: item.kind === 'track' ? `track-${item.trackId}` : `group-${item.groupId}`,
        at: performance.now(),
      };
      const to = landed ? dropAt(e.clientX, e.clientY, item) : null;
      setDrag(null);
      setGhost(null);
      setOver(null);
      if (to) dropOn(item, to);
    };
    const onUp = (e: PointerEvent) => finish(e, true);
    const onCancel = (e: PointerEvent) => finish(e, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // Only the dragged handle's own click is the drag's: any other grip opens its menu at once.
  const justDragged = (handle: string) =>
    dragEnded.current.handle === handle && performance.now() - dragEnded.current.at < 300;

  const trackItems = (track: GroupTrack, group: TrackGroup | null) => {
    const items: MenuItem[] = [];
    if (group) {
      const index = group.tracks.findIndex((tr) => tr.id === track.id);
      if (index > 0) {
        items.push({
          key: 'earlier',
          label: t('trackGroups.moveEarlier'),
          onSelect: () => stepTrack(group, track.id, -1),
        });
      }
      if (index < group.tracks.length - 1) {
        items.push({
          key: 'later',
          label: t('trackGroups.moveLater'),
          onSelect: () => stepTrack(group, track.id, 1),
        });
      }
    }
    for (const other of mine) {
      if (other.id === group?.id) continue;
      // Two of the person's groups may share a name: then their place on the page tells them apart.
      const twin = mine.some((g) => g.id !== other.id && g.name === other.name);
      items.push({
        key: `move-${other.id}`,
        label: twin
          ? t('trackGroups.moveToAt', {
              name: other.name,
              position: groups.findIndex((g) => g.id === other.id) + 1,
            })
          : t('trackGroups.moveTo', { name: other.name }),
        onSelect: () => void placeTrack(other.id, track.id),
      });
    }
    if (group) {
      items.push({
        key: 'out',
        label: t('trackGroups.takeOut', { name: group.name }),
        onSelect: () => void takeOut(group.id, track.id),
      });
    }
    items.push({
      key: 'new',
      label: t('trackGroups.newGroupWith'),
      onSelect: () => setNaming({ mode: 'new', trackIds: [track.id] }),
    });
    return items;
  };

  const groupItems = (group: TrackGroup) => {
    const index = groups.findIndex((g) => g.id === group.id);
    const items: MenuItem[] = [];
    if (index > 0) {
      items.push({
        key: 'earlier',
        label: t('trackGroups.moveEarlier'),
        onSelect: () => stepGroup(group.id, -1),
      });
    }
    if (index < groups.length - 1) {
      items.push({
        key: 'later',
        label: t('trackGroups.moveLater'),
        onSelect: () => stepGroup(group.id, 1),
      });
    }
    if (group.mine) {
      items.push(
        {
          key: 'rename',
          label: t('trackGroups.rename'),
          onSelect: () => setNaming({ mode: 'rename', group }),
        },
        {
          key: 'share',
          label: t('trackGroups.share'),
          onSelect: () => setSharing({ mode: 'share', group }),
        },
        {
          key: 'set-on',
          label: t('trackGroups.setOn'),
          onSelect: () => setSharing({ mode: 'setOn', group }),
        },
        { key: 'delete', label: t('trackGroups.delete'), onSelect: () => setDeleting(group) },
      );
    } else {
      // A group shared with the person: theirs to leave, after saying what goes with it (T-204).
      items.push({
        key: 'leave',
        label: t('trackGroups.leave'),
        onSelect: () => setLeaving(group),
      });
    }
    return items;
  };

  /**
   * Where focus goes once a group has left the page: the next group, the one before, the first
   * track in no group, or the page's hint when nothing else is left.
   */
  const focusAfterRemoving = (at: number) => (next: TrackGroup[]) => {
    const near = next[at] ?? next[at - 1];
    if (near) return `group-${near.id}`;
    const first = tracks.find(
      (tr) => !next.some((g) => g.mine && g.tracks.some((x) => x.id === tr.id)),
    );
    return first ? `track-${first.id}` : 'hint';
  };

  /** What leaving a shared group takes: the role it alone gave, on how many tracks. */
  const leavingBody = (group: TrackGroup) =>
    group.role && (group.holds ?? 0) > 0
      ? t('trackGroups.leave.bodyRole', {
          name: group.name,
          role: group.role.name,
          count: group.holds ?? 0,
        })
      : t('trackGroups.leave.body', { name: group.name });

  const isOver = (drop: Drop) =>
    over !== null &&
    over.kind === drop.kind &&
    (drop.kind === 'loose' ||
      (drop.kind === 'group' && over.kind === 'group' && over.groupId === drop.groupId) ||
      (drop.kind === 'track' && over.kind === 'track' && over.trackId === drop.trackId));

  function trackCard(track: GroupTrack, group: TrackGroup | null) {
    const movable = group === null || group.mine;
    const owner = owners.get(track.id);
    const dragging = drag?.kind === 'track' && drag.trackId === track.id;
    return (
      <li
        key={track.id}
        className={`glass-card tracks-item track-card${dragging ? ' is-dragging' : ''}${
          isOver({ kind: 'track', trackId: track.id, groupId: group?.id ?? null })
            ? ' is-drop-target'
            : ''
        }`}
        data-drop="track"
        data-track-id={track.id}
        data-group-id={group?.id ?? ''}
      >
        <a href={routeHref(trackHref(track.key))}>
          <span className="tracks-item-key">{track.key}</span>
          <span className="tracks-item-name">{track.name}</span>
        </a>
        {owner && (
          <span className="tracks-item-owner">{t('tracks.owner', { name: owner.name })}</span>
        )}
        {movable && (
          <MoveMenu
            label={t('trackGroups.trackActions', { name: track.name })}
            handle={`track-${track.id}`}
            items={trackItems(track, group)}
            justDragged={justDragged}
            onDragStart={(event) =>
              beginDrag(event, {
                kind: 'track',
                trackId: track.id,
                name: track.name,
                groupId: group?.id ?? null,
              })
            }
            {...(group ? { onStep: (d: -1 | 1) => stepTrack(group, track.id, d) } : {})}
          />
        )}
      </li>
    );
  }

  function groupMeta(group: TrackGroup) {
    if (!group.mine) return t('trackGroups.sharedBy', { name: group.owner.name });
    if (group.givenBy) return t('trackGroups.givenBy', { name: group.givenBy.name });
    if (group.sharedWith) return t('trackGroups.sharedWith', { count: group.sharedWith });
    return null;
  }

  function groupItem(group: TrackGroup) {
    const titleId = `${id}-group-${group.id}`;
    const meta = groupMeta(group);
    const dragging = drag?.kind === 'group' && drag.groupId === group.id;
    return (
      <li
        key={group.id}
        className={`track-group ${group.minimized ? 'is-minimized' : 'is-open'}${
          dragging ? ' is-dragging' : ''
        }${isOver({ kind: 'group', groupId: group.id }) ? ' is-drop-target' : ''}`}
        data-drop="group"
        data-group-id={group.id}
      >
        <section
          aria-labelledby={titleId}
          className={`glass-card ${group.minimized ? 'track-group-mini' : 'track-group-bubble'}`}
        >
          <div className="track-group-head">
            <MoveMenu
              label={t('trackGroups.groupActions', { name: group.name })}
              handle={`group-${group.id}`}
              items={groupItems(group)}
              justDragged={justDragged}
              onStep={(d) => stepGroup(group.id, d)}
              onDragStart={(event) =>
                beginDrag(event, { kind: 'group', groupId: group.id, name: group.name })
              }
            />
            <h2 id={titleId} className="track-group-name">
              {group.name}
            </h2>
            <span className="track-group-count">
              {t('trackGroups.count', { count: group.tracks.length })}
            </span>
            <button
              type="button"
              className="icon-button track-group-toggle"
              aria-expanded={!group.minimized}
              aria-label={t(group.minimized ? 'trackGroups.open' : 'trackGroups.minimize', {
                name: group.name,
              })}
              onClick={() =>
                void run(
                  () => client.update(group.id, { minimized: !group.minimized }),
                  () =>
                    t(
                      group.minimized
                        ? 'trackGroups.announce.opened'
                        : 'trackGroups.announce.minimized',
                      {
                        name: group.name,
                      },
                    ),
                )
              }
            >
              <ChevronDownIcon />
            </button>
          </div>
          {meta && <p className="track-group-meta">{meta}</p>}
          {group.minimized ? (
            <div className="track-group-squares" aria-hidden="true">
              {group.tracks.slice(0, SQUARES).map((track) => (
                <span key={track.id} className="track-group-square">
                  {track.key.slice(0, 1)}
                </span>
              ))}
            </div>
          ) : group.tracks.length === 0 ? (
            <p className="page-note track-group-empty">
              {t(group.mine ? 'trackGroups.empty' : 'trackGroups.emptyShared')}
            </p>
          ) : (
            <ul className="tracks-list track-group-tracks">
              {group.tracks.map((track) => trackCard(track, group))}
            </ul>
          )}
        </section>
      </li>
    );
  }

  const looseList =
    loose.length === 0 ? (
      <p className="page-note">{t('trackGroups.allGrouped')}</p>
    ) : (
      <ul className="tracks-list">{loose.map((track) => trackCard(track, null))}</ul>
    );

  return (
    <div className="track-arrangement" aria-busy={busy}>
      <p className="page-note track-arrangement-hint" data-handle="hint" tabIndex={-1}>
        {t(compact ? 'trackGroups.hintCompact' : 'trackGroups.hint')}
      </p>
      <p role="status" className="visually-hidden">
        {said}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {groups.length > 0 && (
        <ul className="track-groups" aria-label={t('trackGroups.groups')}>
          {groups.map(groupItem)}
        </ul>
      )}
      {groups.length > 0 ? (
        <section
          aria-labelledby={`${id}-loose`}
          className={`track-ungrouped${isOver({ kind: 'loose' }) ? ' is-drop-target' : ''}`}
          data-drop="loose"
        >
          <h2 id={`${id}-loose`} className="section-title">
            {t('trackGroups.ungrouped')}
          </h2>
          {drag?.kind === 'track' && drag.groupId !== null && (
            <p className="page-note">{t('trackGroups.dropOut')}</p>
          )}
          {looseList}
        </section>
      ) : (
        <div className="track-ungrouped" data-drop="loose">
          {looseList}
        </div>
      )}
      {drag && ghost && (
        <div
          className="track-drag-ghost"
          aria-hidden="true"
          style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
        >
          {drag.name}
        </div>
      )}
      {naming && (
        <GroupNameDialog
          mode={naming.mode}
          {...(naming.mode === 'rename' ? { initial: naming.group.name } : {})}
          onClose={() => setNaming(null)}
          onSave={(name) => {
            const current = naming;
            setNaming(null);
            if (current.mode === 'new') void makeGroup(name, current.trackIds);
            else {
              void run(
                () => client.update(current.group.id, { name }),
                () => t('trackGroups.announce.renamed', { name }),
                () => `group-${current.group.id}`,
              );
            }
          }}
        />
      )}
      {sharing && (
        <ShareGroupDialog
          mode={sharing.mode}
          group={sharing.group}
          client={client}
          onClose={() => setSharing(null)}
          onChanged={() => void client.layout().then(onGroups, () => {})}
        />
      )}
      {deleting && (
        <ModalDialog
          onClose={() => setDeleting(null)}
          labelledBy={`${id}-delete`}
          closeLabel={t('trackGroups.closeDialog')}
        >
          <h2 id={`${id}-delete`} className="section-title">
            {t('trackGroups.delete.title', { name: deleting.name })}
          </h2>
          <p className="page-note">{t('trackGroups.delete.body')}</p>
          <div className="form-actions">
            <button
              type="button"
              className="button-danger"
              onClick={() => {
                const group = deleting;
                const at = groups.findIndex((g) => g.id === group.id);
                setDeleting(null);
                void run(
                  () => client.remove(group.id),
                  () => t('trackGroups.announce.deleted', { name: group.name }),
                  // Focus stays where the person was.
                  focusAfterRemoving(at),
                );
              }}
            >
              {t('trackGroups.delete.do')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setDeleting(null)}>
              {t('trackGroups.cancel')}
            </button>
          </div>
        </ModalDialog>
      )}
      {leaving && (
        <ModalDialog
          onClose={() => setLeaving(null)}
          labelledBy={`${id}-leave`}
          closeLabel={t('trackGroups.closeDialog')}
        >
          <h2 id={`${id}-leave`} className="section-title">
            {t('trackGroups.leave.title', { name: leaving.name })}
          </h2>
          <p className="page-note">{leavingBody(leaving)}</p>
          <p className="page-note">{t('trackGroups.leave.again', { name: leaving.owner.name })}</p>
          <div className="form-actions">
            <button
              type="button"
              className="button-danger"
              onClick={() => {
                const group = leaving;
                const at = groups.findIndex((g) => g.id === group.id);
                setLeaving(null);
                void run(
                  () => client.leave(group.id),
                  () => t('trackGroups.announce.left', { name: group.name }),
                  focusAfterRemoving(at),
                );
              }}
            >
              {t('trackGroups.leave.do')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setLeaving(null)}>
              {t('trackGroups.cancel')}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

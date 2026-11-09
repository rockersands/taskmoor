import type { TimelineItem } from './client';

/** A group of rows: its id and its heading, for one ticket. */
export interface TimelineGroup {
  id: string;
  label: string;
}

export type TimelineRow =
  | { kind: 'group'; id: string; label: string; count: number }
  | { kind: 'item'; item: TimelineItem; depth: number; hasChildren: boolean };

/**
 * A timeline's rows in the order they are drawn, on the page and in its image: parents above their
 * children, under group headings sorted by name when there are groups. What is collapsed adds no
 * rows; an image collapses nothing.
 */
export function timelineRows(
  items: readonly TimelineItem[],
  groupOf?: (item: TimelineItem) => TimelineGroup,
  collapsed: ReadonlySet<number> = new Set(),
  closedGroups: ReadonlySet<string> = new Set(),
): TimelineRow[] {
  const listed = new Set(items.map((i) => i.id));
  const out: TimelineRow[] = [];
  const tree = (list: readonly TimelineItem[]) => {
    const inGroup = new Set(list.map((i) => i.id));
    const children = new Map<number, TimelineItem[]>();
    for (const i of list) {
      if (i.parentId !== null && inGroup.has(i.parentId)) {
        children.set(i.parentId, [...(children.get(i.parentId) ?? []), i]);
      }
    }
    const visit = (item: TimelineItem, depth: number) => {
      const kids = children.get(item.id) ?? [];
      out.push({ kind: 'item', item, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(item.id)) for (const k of kids) visit(k, depth + 1);
    };
    for (const i of list) {
      if (i.parentId === null || !listed.has(i.parentId) || !inGroup.has(i.parentId)) visit(i, 0);
    }
  };
  if (!groupOf) {
    tree(items);
    return out;
  }
  const groups = new Map<string, { label: string; items: TimelineItem[] }>();
  for (const i of items) {
    const g = groupOf(i);
    const entry = groups.get(g.id) ?? { label: g.label, items: [] };
    entry.items.push(i);
    groups.set(g.id, entry);
  }
  for (const [gid, g] of [...groups].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
    out.push({ kind: 'group', id: gid, label: g.label, count: g.items.length });
    if (!closedGroups.has(gid)) tree(g.items);
  }
  return out;
}

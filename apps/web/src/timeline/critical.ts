import type { TimelineItem } from './client';
import { barOf } from './dependencies';

/**
 * The critical path on a timeline (PLN-011; ADR-122 stage 9). The server works it out over the
 * whole plan the viewer is shown and gives the slack of the tickets the page lists; these say what
 * the page draws from it. A ticket with slack of 0 or less is on the path; one with no slack given
 * (closed, undated, rolled up or in a circle of links) is not judged.
 */
export type Slack = ReadonlyMap<number, number>;

export const isCritical = (slack: Slack | null | undefined, id: number): boolean => {
  const s = slack?.get(id);
  return s !== undefined && s <= 0;
};

/**
 * Whether a link between two tickets on the path is tight: the days between the two bars equal
 * the difference of their slack (with slack 0 on both, the second starts the day after the first
 * ends). The page draws these links heavier.
 */
export function tightLink(
  slack: Slack | null | undefined,
  from: TimelineItem,
  to: TimelineItem,
): boolean {
  if (!isCritical(slack, from.id) || !isCritical(slack, to.id)) return false;
  const a = barOf(from);
  const b = barOf(to);
  if (!a || !b) return false;
  const gap = b.start - a.due - 1;
  return gap === (slack?.get(from.id) as number) - (slack?.get(to.id) as number);
}

/** The slack the critical-path answer lists, by ticket id. */
export const slackMap = (listed: readonly { id: number; slack: number }[]): Slack =>
  new Map(listed.map((l) => [l.id, l.slack]));

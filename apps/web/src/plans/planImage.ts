import type { useT } from '../i18n/I18nProvider';
import { typeName } from '../shell/seededNames';
import { dayNumber } from '../timeline/client';
import { type Blocked, barOf, blockerCount, dependencyState } from '../timeline/dependencies';
import { drawnReleases, releaseMarkerText } from '../timeline/markers';
import { type TimelineGroup, type TimelineRow, timelineRows } from '../timeline/rows';
import { GROUP_LABELS, type PlanGroup } from './address';
import type { PlanFilters, PlanTimeline, PlanTimelineItem } from './client';

/**
 * A plan's Timeline as a picture (T-089g; PLN-014; ADR-122 stage 8). It is drawn, not captured: past
 * 200 rows the page holds only those in view, and a capture would bring in glass and backgrounds.
 * One pure function makes an SVG text from the rows the page draws, then an image from a Blob URL
 * and a canvas make the PNG, in the browser; nothing leaves it. No `foreignObject`, external font or
 * link, so the canvas is never tainted, and every text is escaped, so a summary of
 * `</text><script>` reads as written.
 *
 * Fixed light colours, chosen for print: the skin does not change the picture. A late dependency is
 * dashed and says "late" in words, never by colour alone.
 */
type T = ReturnType<typeof useT>;

/** How many rows an image holds at most, group headings among them. */
export const IMAGE_ROWS = 400;
const WIDTH = 1600;
/** 2x while the picture stays within this many pixels, which phones' canvases can draw. */
const MAX_AREA = 16_000_000;
const ROW = 24;
const LABEL = 420;
const PAD = 16;
/** Characters of a ticket's summary beside its key, and of any other line. */
const SUMMARY_CHARS = 44;
const LINE_CHARS = 180;

const COLOURS = {
  paper: '#ffffff',
  ink: '#1c2230',
  muted: '#566072',
  rule: '#d9dde5',
  band: '#f2f4f8',
  bar: '#3f6fc4',
  rollup: '#8a97ad',
  today: '#0f7b6c',
  release: '#7a4fb5',
  late: '#b3261e',
};

/** Text as XML takes it: escaped, without what XML cannot hold at all. */
export function escapeXml(text: string): string {
  return (
    text
      // Control characters and lone surrogates would make the whole picture fail to load.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: these are what it takes out
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ' ')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ' ')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;')
  );
}

/** At most `limit` characters, whole ones, with an ellipsis when cut. */
function cut(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

/** The filters and the grouping in words, for the top of the picture. */
export function viewWords(
  t: T,
  filters: PlanFilters,
  group: PlanGroup | null,
  items: readonly PlanTimelineItem[],
): string[] {
  const words: string[] = [];
  const named = (label: string, value: string) => t('plans.image.filter', { label, value });
  if (filters.track) words.push(named(t('plans.filter.track'), filters.track));
  if (filters.assignee) {
    const person = items.find((i) => String(i.assignee?.id) === filters.assignee)?.assignee?.name;
    words.push(
      named(
        t('plans.filter.assignee'),
        filters.assignee === 'me'
          ? t('plans.filter.me')
          : filters.assignee === 'none'
            ? t('plans.filter.nobody')
            : (person ?? t('plans.filter.person')),
      ),
    );
  }
  if (filters.type) words.push(named(t('plans.filter.type'), typeName(t, filters.type)));
  if (filters.stage) {
    words.push(named(t('plans.filter.stage'), t(`search.stage.${filters.stage}`)));
  }
  if (group) words.push(named(t('plans.groupBy'), t(GROUP_LABELS[group])));
  return words;
}

export interface TimelineImageInput {
  t: T;
  plan: string;
  /** The filters and the grouping in words. */
  view: readonly string[];
  /** The day it was made, in words, and today as a day number. */
  madeOn: string;
  today: number;
  data: PlanTimeline;
  groupOf?: (item: PlanTimelineItem) => TimelineGroup;
  dependencies: ReadonlyMap<number, Blocked>;
  /** Sources of the plan hidden from the person: only counted. */
  hiddenSources: number;
  /** A day's month, in words: "Nov 2026". */
  monthText: (day: number) => string;
}

export interface TimelineImage {
  svg: string;
  width: number;
  height: number;
  /** How many times larger the PNG is drawn. */
  scale: number;
  /** How many rows it holds, of how many. */
  rows: number;
  total: number;
}

/** The rows an image of this timeline would hold, of how many (group headings count). */
export function imageRows(
  data: PlanTimeline,
  groupOf?: (item: PlanTimelineItem) => TimelineGroup,
): { rows: TimelineRow[]; total: number } {
  const all = timelineRows(
    data.items,
    groupOf ? (item) => groupOf(item as PlanTimelineItem) : undefined,
  );
  return { rows: all.slice(0, IMAGE_ROWS), total: all.length };
}

/** The first day of the month after `day`. */
function nextMonth(day: number): number {
  const d = new Date(day * 86_400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86_400_000;
}

/** A timeline as an SVG text. */
export function timelineSvg(input: TimelineImageInput): TimelineImage {
  const { t, data, today, dependencies } = input;
  const { rows, total } = imageRows(data, input.groupOf);
  const released = drawnReleases(data.markers.releases);

  // Every bar and marker on the picture, and today, with a little room.
  let first = today;
  let last = today;
  const see = (day: number) => {
    if (day < first) first = day;
    if (day > last) last = day;
  };
  for (const row of rows) {
    if (row.kind !== 'item') continue;
    const bar = barOf(row.item);
    if (bar) {
      see(bar.start);
      see(bar.due);
    }
  }
  for (const r of released) see(dayNumber(r.date));
  first -= 3;
  last += 3;
  const lanes = WIDTH - LABEL - PAD;
  const perDay = lanes / (last - first + 1);
  const dayX = (day: number) => LABEL + (day - first) * perDay;

  const notes: string[] = [];
  if (total > rows.length) {
    notes.push(t('plans.image.capped', { rows: rows.length, total }));
  } else {
    notes.push(t('plans.image.rows', { rows: rows.length }));
  }
  if (data.truncated) notes.push(t('plans.truncated', { count: data.items.length }));
  if (input.hiddenSources > 0) {
    notes.push(t('plans.notice.hidden', { count: input.hiddenSources }));
  }
  let outside = 0;
  let unlisted = 0;
  for (const blocked of dependencies.values()) {
    outside += blocked.outside;
    unlisted += blocked.unlisted;
  }
  if (outside > 0) notes.push(t('dependencies.outside', { count: outside }));
  if (unlisted > 0) notes.push(t('plans.image.unlisted', { count: unlisted }));

  const out: string[] = [];
  const text = (
    x: number,
    y: number,
    words: string,
    options: { size?: number; weight?: number; fill?: string; anchor?: string } = {},
  ) =>
    out.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${options.size ?? 12}"${
        options.weight ? ` font-weight="${options.weight}"` : ''
      } fill="${options.fill ?? COLOURS.ink}"${
        options.anchor ? ` text-anchor="${options.anchor}"` : ''
      }>${escapeXml(words)}</text>`,
    );

  let y = PAD + 18;
  text(PAD, y, cut(input.plan, 90), { size: 20, weight: 700 });
  y += 20;
  text(PAD, y, cut(input.madeOn, LINE_CHARS), { fill: COLOURS.muted });
  if (input.view.length > 0) {
    y += 16;
    text(PAD, y, cut(input.view.join(' · '), LINE_CHARS), { fill: COLOURS.muted });
  }
  for (const note of notes) {
    y += 16;
    text(PAD, y, cut(note, LINE_CHARS), { fill: COLOURS.muted });
  }
  y += 22;

  // Month headers; when months would run together, only the first of each year.
  const monthsTop = y;
  const wide = perDay * 30 >= 56;
  for (let day = first; day <= last; day = nextMonth(day)) {
    const date = new Date(day * 86_400_000);
    if (wide || date.getUTCMonth() === 0 || day === first) {
      text(dayX(day) + 3, y, input.monthText(day), { fill: COLOURS.muted, size: 11 });
    }
    out.push(
      `<line x1="${dayX(day).toFixed(1)}" x2="${dayX(day).toFixed(1)}" y1="${y - 12}" y2="@BOTTOM@" stroke="${COLOURS.rule}"/>`,
    );
  }
  y += 8;

  // Release markers, staggered over three lines so their names can be read.
  const markersTop = y;
  released.forEach((r, i) => {
    const line = i % 3;
    const x = dayX(dayNumber(r.date));
    const at = markersTop + 14 + line * 14;
    out.push(
      `<path d="M${x.toFixed(1)} ${at - 9}l4 4l-4 4l-4 -4z" fill="${COLOURS.release}"/>`,
      `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${at - 1}" y2="@BOTTOM@" stroke="${COLOURS.release}" stroke-opacity="0.35"/>`,
    );
    const words = cut(releaseMarkerText(t, r), 40);
    const flip = x > WIDTH - 260;
    text(x + (flip ? -7 : 7), at, words, {
      size: 11,
      fill: COLOURS.release,
      ...(flip ? { anchor: 'end' } : {}),
    });
  });
  y += released.length > 0 ? 14 * Math.min(3, released.length) + 8 : 0;

  const rowsTop = y;
  const rowAt = new Map<number, number>();
  rows.forEach((row, i) => {
    if (row.kind === 'item') rowAt.set(row.item.id, i);
  });
  const barY = (i: number) => rowsTop + i * ROW + 5;

  rows.forEach((row, i) => {
    const top = rowsTop + i * ROW;
    if (row.kind === 'group') {
      out.push(`<rect x="0" y="${top}" width="${WIDTH}" height="${ROW}" fill="${COLOURS.band}"/>`);
      text(
        PAD,
        top + 16,
        t('timeline.group.title', { name: cut(row.label, 80), count: row.count }),
        { weight: 700 },
      );
      return;
    }
    const { item, depth } = row;
    out.push(
      `<line x1="0" x2="${WIDTH}" y1="${top + ROW}" y2="${top + ROW}" stroke="${COLOURS.rule}"/>`,
    );
    const indent = PAD + Math.min(depth, 6) * 12;
    text(indent, top + 16, `${item.key}  ${cut(item.summary, SUMMARY_CHARS - Math.min(depth, 6))}`);
    const bar = barOf(item);
    if (bar) {
      const x = dayX(bar.start);
      const width = Math.max(3, (bar.due - bar.start + 1) * perDay);
      out.push(
        `<rect x="${x.toFixed(1)}" y="${top + 5}" width="${width.toFixed(1)}" height="${ROW - 10}" rx="3" fill="${
          bar.kind === 'rollup' ? COLOURS.rollup : COLOURS.bar
        }"/>`,
      );
      const blocked = dependencies.get(item.id);
      if (blocked) {
        const words =
          blocked.late > 0
            ? t('timeline.badge.late', { count: blockerCount(blocked) })
            : String(blockerCount(blocked));
        const after = x + width + 5;
        const flip = after > WIDTH - 90;
        text(flip ? x - 5 : after, top + 16, words, {
          size: 11,
          weight: 700,
          fill: blocked.late > 0 ? COLOURS.late : COLOURS.muted,
          ...(flip ? { anchor: 'end' } : {}),
        });
      }
    }
  });

  // Dependency lines between rows on the picture; a late one is dashed, in the late colour.
  for (const { from, to } of data.links) {
    const a = rowAt.get(from);
    const b = rowAt.get(to);
    if (a === undefined || b === undefined) continue;
    const blocker = (rows[a] as Extract<TimelineRow, { kind: 'item' }>).item;
    const held = (rows[b] as Extract<TimelineRow, { kind: 'item' }>).item;
    const start = barOf(blocker);
    const end = barOf(held);
    if (!start || !end) continue;
    const late = dependencyState(blocker, held) === 'late';
    const x1 = dayX(start.due + 1);
    const x2 = dayX(end.start);
    const y1 = barY(a) + (ROW - 10) / 2;
    const y2 = barY(b) + (ROW - 10) / 2;
    const middle = Math.max(x1, x2 - 6).toFixed(1);
    out.push(
      `<path d="M${x1.toFixed(1)} ${y1}H${middle}V${y2}H${x2.toFixed(1)}" fill="none" stroke="${
        late ? COLOURS.late : COLOURS.muted
      }"${late ? ' stroke-dasharray="5 3"' : ''}/>`,
    );
  }

  const bottom = rowsTop + rows.length * ROW;
  // Today's line, named, on top of the rows.
  if (today >= first && today <= last) {
    const x = dayX(today);
    out.push(
      `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${monthsTop - 12}" y2="${bottom}" stroke="${COLOURS.today}" stroke-width="2"/>`,
    );
    text(x + 4, bottom + 14, t('plans.image.today'), { size: 11, fill: COLOURS.today });
  }
  let height = bottom + 24;
  if (data.links.length > 0) {
    text(PAD, height, t('plans.image.legend'), { size: 11, fill: COLOURS.muted });
    height += 8;
  }
  height += PAD;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Arial, Helvetica, sans-serif"><rect width="${WIDTH}" height="${height}" fill="${COLOURS.paper}"/>${out
    .join('')
    .replaceAll('@BOTTOM@', String(bottom))}</svg>`;
  return {
    svg,
    width: WIDTH,
    height,
    scale: WIDTH * height * 4 <= MAX_AREA ? 2 : 1,
    rows: rows.length,
    total,
  };
}

/** The picture as a PNG, in the browser; it rejects when the browser cannot draw it. */
export function svgToPng(image: TimelineImage): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([image.svg], { type: 'image/svg+xml' }));
    const picture = new Image();
    const done = () => URL.revokeObjectURL(url);
    picture.onerror = () => {
      done();
      reject(new Error('image_failed'));
    };
    picture.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.width * image.scale;
        canvas.height = image.height * image.scale;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('image_failed');
        context.scale(image.scale, image.scale);
        context.drawImage(picture, 0, 0);
        canvas.toBlob((blob) => {
          done();
          if (blob) resolve(blob);
          else reject(new Error('image_failed'));
        }, 'image/png');
      } catch (error) {
        done();
        reject(error);
      }
    };
    picture.src = url;
  });
}

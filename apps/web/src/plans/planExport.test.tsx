import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CSV_BOM } from '@taskmoor/webconfig';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, useT } from '../i18n/I18nProvider';
import { dayNumber } from '../timeline/client';
import { dependenciesOf } from '../timeline/dependencies';
import type { PlanTimeline, PlanTimelineItem } from './client';
import { fileName } from './download';
import { fakePlanClient, manyPlanItems } from './fixtures';
import {
  calendarCsv,
  capacityCsv,
  csvText,
  releasesCsv,
  summaryCsv,
  timelineCsv,
} from './planExport';
import { escapeXml, IMAGE_ROWS, imageRows, timelineSvg, viewWords } from './planImage';

const translate = (locale: 'en' | 'es' = 'en') =>
  renderHook(() => useT(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider locale={locale}>{children}</I18nProvider>
    ),
  }).result.current;

/**
 * A file's rows, read as RFC 4180 reads them, after its byte-order mark: every file starts with
 * exactly one (T-252), as the importer expects and takes off.
 */
function parse(file: string): string[][] {
  expect(file.startsWith(CSV_BOM)).toBe(true);
  const text = file.slice(1);
  expect(text.startsWith(CSV_BOM)).toBe(false);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

/**
 * A file against its golden copy, with plain line ends so git cannot change what it compares. It is
 * written when missing, outside CI, as a snapshot is: review the diff. The web project's jsdom setup
 * has no snapshot state, so this reads from disk, as the design guard does.
 */
const src = ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'styles/tokens.css'))) ?? 'src';
function matchesGolden(text: string, name: string) {
  const path = join(src, 'plans/__golden__', name);
  // The byte-order mark is checked by `parse`; the golden copy holds the table after it.
  expect(text.startsWith(CSV_BOM)).toBe(true);
  const plain = text.slice(1).replaceAll('\r\n', '\n');
  if (!existsSync(path) && !process.env.CI) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plain);
  }
  expect(plain).toBe(readFileSync(path, 'utf8'));
}

const TODAY = dayNumber('2026-11-04');
const imageOf = async (extra: { data?: PlanTimeline; hiddenSources?: number } = {}) => {
  const t = translate();
  const data = extra.data ?? (await fakePlanClient().timeline(12, {}));
  return timelineSvg({
    t,
    plan: 'Spring launch',
    view: viewWords(t, { track: 'SHOP' }, 'assignee', data.items),
    madeOn: t('plans.image.made', { day: '2026-11-04' }),
    today: TODAY,
    data,
    dependencies: dependenciesOf(data.items, data.links, data.blockersElsewhere),
    hiddenSources: extra.hiddenSources ?? 0,
    monthText: (day) => new Date(day * 86_400_000).toISOString().slice(0, 7),
  });
};

describe('the files of a plan', () => {
  it('[PLN-014] writes cells by the rule every CSV export shares, the byte-order mark first and once', () => {
    // The cell guard's table is the shared helper's (`@taskmoor/webconfig` `csv.test.ts`).
    const text = csvText([
      ['a', 'b,c'],
      [null, 1],
      ['=1+1', 'Versión'],
    ]);
    expect(text).toBe(`${CSV_BOM}a,"b,c"\r\n,1\r\n'=1+1,Versión\r\n`);
    expect([...new TextEncoder().encode(text).slice(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
  });

  it('[PLN-014] [PLN-006] the Timeline file holds its rows, with blockers it does not list as numbers', async () => {
    const data = await fakePlanClient().timeline(12, {});
    const rows = parse(timelineCsv(translate(), data));
    expect(rows[0]).toEqual([
      'Key',
      'Summary',
      'Type',
      'Track',
      'Status',
      'Start',
      'Due',
      'Days come from',
      'Children start',
      'Children due',
      'Children closed',
      'Children',
      'Blockers listed',
      'Late blockers',
      'Blockers outside this plan or hidden',
      'Blockers of this plan left out here',
    ]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(data.items.map((i) => i.key));
    const line = (key: string) => rows.find((r) => r[0] === key) as string[];
    expect(line('SHOP-3').slice(0, 8)).toEqual([
      'SHOP-3',
      'Take payments',
      'Feature',
      'SHOP',
      'New',
      '2026-11-09',
      '2026-11-20',
      'The ticket',
    ]);
    // SHOP-3 is blocked by SHOP-2, late; OPS-4 by a listed ticket and two only counted.
    expect(line('SHOP-3').slice(12)).toEqual(['1', '1', '0', '0']);
    expect(line('OPS-4').slice(12, 16)).toEqual(['1', '0', '2', '0']);
    // The outcome's roll-up: its children's span.
    expect(line('SHOP-1').slice(8, 12)).toEqual(['2026-11-02', '2026-11-20', '0', '2']);
    matchesGolden(timelineCsv(translate(), data), 'plan-timeline.csv');
  });

  it('[PLN-014] [PLN-006] a blocker the filters leave out is counted apart, never named', async () => {
    const data = await fakePlanClient().timeline(12, { track: 'OPS' });
    const text = timelineCsv(translate(), data);
    const rows = parse(text);
    expect(rows.find((r) => r[0] === 'OPS-4')?.slice(12, 16)).toEqual(['0', '0', '2', '1']);
    // SHOP-3, which OPS-4 blocks and which the filter leaves out, is named nowhere in the file.
    expect(text).not.toContain('SHOP-3');
  });

  it('[PLN-014] a formula in a summary or a track name does not run from the file', async () => {
    const items: PlanTimelineItem[] = (await fakePlanClient().timeline(12, {})).items.map((i) => ({
      ...i,
      summary: `=HYPERLINK("http://example.test","${i.key}")`,
    }));
    const data = {
      ...(await fakePlanClient().timeline(12, {})),
      items,
      links: [],
      blockersElsewhere: [],
    };
    for (const row of parse(timelineCsv(translate(), data)).slice(1)) {
      expect(row[1]?.startsWith("'=")).toBe(true);
    }
  });

  it('[PLN-014] the Calendar file holds the entries of the month', async () => {
    const data = await fakePlanClient().calendar(12, {}, '2026-10-26', '2026-11-29');
    const rows = parse(calendarCsv(translate(), data));
    expect(rows[0]).toEqual(['Key', 'Summary', 'Type', 'Track', 'Stage', 'Start', 'Due']);
    expect(rows.slice(1).map((r) => r[0])).toEqual(data.tickets.map((x) => x.key));
    expect(rows.find((r) => r[0] === 'SHOP-2')?.slice(3, 5)).toEqual(['SHOP', 'Active']);
    matchesGolden(calendarCsv(translate(), data), 'plan-calendar.csv');
  });

  it('[PLN-014] the Summary file holds each measure, its number and its search', async () => {
    const data = await fakePlanClient().summary(12, {});
    const rows = parse(summaryCsv(translate(), data));
    expect(rows[0]).toEqual(['Section', 'Measure', 'Number', 'Search']);
    expect(rows[1]).toEqual([
      'Overview',
      'All tickets',
      String(data.total.count),
      data.total.query,
    ]);
    const measures = [...data.overview, ...data.stages, ...data.tracks, ...data.assignees];
    expect(rows).toHaveLength(2 + measures.length);
    for (const m of measures) expect(rows.some((r) => r[3] === m.query)).toBe(true);
    matchesGolden(summaryCsv(translate(), data), 'plan-summary.csv');
  });

  it('[PLN-014] [PLN-005] the Capacity file keeps other work a count and an amount, headed as whole weeks', async () => {
    const data = await fakePlanClient().capacity(12, {}, '2026-11-04', 3);
    const text = capacityCsv(translate(), data);
    const rows = parse(text);
    expect(rows[0]).toContain('Tickets elsewhere (counted by whole weeks)');
    expect(rows[0]).toContain('Work elsewhere (counted by whole weeks)');
    const ana = rows.filter((r) => r[1] === 'Ana Ruiz');
    // Three periods and what is unscheduled.
    expect(ana).toHaveLength(4);
    expect(ana[0]?.slice(2, 3)).toEqual([data.periods[0]?.start]);
    expect(ana[0]?.at(8)).toBe('Yes');
    expect(ana[0]?.slice(-2)).toEqual(['1', '13']);
    expect(ana[3]?.[2]).toBe('Open, no due date');
    // Notes stay on the page: they may say why someone was away.
    const noted = await fakePlanClient().capacity(12, {}, '2026-11-04', 3);
    const team = noted.teams[0];
    if (team?.capacity.periods[0]) team.capacity.periods[0].note = 'Parental leave';
    expect(capacityCsv(translate(), noted)).not.toContain('Parental leave');
    matchesGolden(text, 'plan-capacity.csv');
  });

  it('[PLN-014] [PLN-007] the Releases file keeps hidden work two numbers', async () => {
    const data = await fakePlanClient().releases(12);
    const rows = parse(releasesCsv(translate(), data));
    expect(rows[0]?.slice(-2)).toEqual(['Hidden releases', 'Open tickets in hidden releases']);
    const cross = rows.find((r) => r[1] === 'Launch across tracks');
    expect(cross?.slice(-2)).toEqual(['1', '4']);
    expect(rows.some((r) => r[0] === 'Launch across tracks' && r[2] === 'SHOP')).toBe(true);
    matchesGolden(releasesCsv(translate(), data), 'plan-releases.csv');
  });

  it('[PLN-014] heads a file in the language of the person', async () => {
    const data = await fakePlanClient().timeline(12, {});
    expect(parse(timelineCsv(translate('es'), data))[0]?.slice(0, 3)).toEqual([
      'Clave',
      'Resumen',
      'Tipo',
    ]);
  });

  it('[PLN-014] names a file from safe characters only', () => {
    expect(fileName('Spring launch', 'timeline', '2026-11-04', 'csv')).toBe(
      'Spring-launch-timeline-2026-11-04.csv',
    );
    expect(fileName('../../etc/passwd "x"\r\n', 'list', '2026-11-04', 'csv')).toBe(
      'etc-passwd-x-list-2026-11-04.csv',
    );
    expect(fileName('¿Qué?', 'summary', '2026-11-04', 'csv')).toBe('Qué-summary-2026-11-04.csv');
    expect(fileName('Planificación', 'summary', '2026-11-04', 'csv')).toBe(
      'Planificación-summary-2026-11-04.csv',
    );
    expect(fileName('···', 'summary', '2026-11-04', 'png')).toBe('plan-summary-2026-11-04.png');
  });
});

describe("the image of a plan's Timeline", () => {
  const parsed = (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    return doc;
  };

  it('[PLN-014] holds its rows, its filters, its day and late in words', async () => {
    const image = await imageOf();
    const doc = parsed(image.svg);
    const words = [...doc.querySelectorAll('text')].map((x) => x.textContent ?? '');
    const all = words.join('\n');
    expect(all).toContain('Spring launch');
    expect(all).toContain('Made on 2026-11-04');
    expect(all).toContain('Track: SHOP');
    expect(all).toContain('Group by: Assignee');
    expect(all).toContain('5 rows.');
    for (const key of ['SHOP-1', 'SHOP-2', 'SHOP-3', 'OPS-4', 'OPS-5']) {
      expect(all).toContain(key);
    }
    expect(all).toContain('Today');
    expect(all).toContain('Shop 2.0');
    // SHOP-3 starts before SHOP-2 ends: a dashed line, and "late" in words, not colour alone.
    expect(all).toMatch(/1 · late/);
    expect(doc.querySelectorAll('path[stroke-dasharray]')).toHaveLength(1);
    // Outside blockers as the page words them, only counted.
    expect(all).toContain('Blocked by 2 tickets outside this plan');
    // Nothing that could reach out or taint the canvas.
    expect(image.svg).not.toMatch(/foreignObject|<image|href=|<script|@font-face|url\(/);
    expect(image.width).toBe(1600);
    expect(image.scale).toBe(2);
    expect(image.rows).toBe(5);
    expect(image.total).toBe(5);
  });

  it('[PLN-014] says how many rows it holds of how many, within what a phone can draw', async () => {
    const items = manyPlanItems(1240);
    const fake = fakePlanClient({ items });
    const image = await imageOf({ data: await fake.timeline(12, {}) });
    expect(image.rows).toBe(IMAGE_ROWS);
    expect(image.total).toBe(1240);
    const doc = parsed(image.svg);
    const all = [...doc.querySelectorAll('text')].map((x) => x.textContent).join('\n');
    expect(all).toContain('First 400 of 1,240 rows: filter the plan for the rest.');
    expect(all).toContain(items[399]?.key);
    expect(all).not.toContain(`${items[400]?.key}  `);
    expect(image.width * image.height * image.scale ** 2).toBeLessThanOrEqual(16_000_000);
    expect(imageRows(await fake.timeline(12, {})).rows).toHaveLength(IMAGE_ROWS);
  });

  it('[PLN-014] says hidden sources as the page does, and keeps group headings among the rows', async () => {
    const data = await fakePlanClient().timeline(12, {});
    const image = await imageOf({ hiddenSources: 2 });
    expect(parsed(image.svg).documentElement.textContent).toContain(
      '2 sources of this plan are hidden from you',
    );
    const grouped = imageRows(data, (i) => ({
      id: String(i.trackId),
      label: i.trackId === 1 ? 'Shop' : 'Ops',
    }));
    expect(grouped.total).toBe(data.items.length + 2);
    expect(grouped.rows[0]).toMatchObject({ kind: 'group', label: 'Ops' });
  });

  it.each([
    ['</text><script>alert(1)</script>', '&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['a & b', 'a &amp; b'],
    ['"quoted"', '&quot;quoted&quot;'],
    ["it's", 'it&apos;s'],
    ['bell\u0007 and \u0001', 'bell  and  '],
    ['lone \ud83d', 'lone  '],
    ['emoji \u{1f680}', 'emoji \u{1f680}'],
  ])('[PLN-014] escapes %s', async (text, written) => {
    expect(escapeXml(text)).toBe(written);
    const data = await fakePlanClient().timeline(12, {});
    data.items[0] = { ...(data.items[0] as PlanTimelineItem), summary: text };
    const doc = parsed((await imageOf({ data })).svg);
    expect(doc.querySelector('script')).toBeNull();
  });
});

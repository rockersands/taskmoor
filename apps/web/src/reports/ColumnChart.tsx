import { useId, useState } from 'react';
import { niceTicks, type Tone, useElementWidth } from './chart';

export interface ColumnSeries {
  id: string;
  label: string;
  tone: Exclude<Tone, 'guide'>;
  values: number[];
}

export interface ColumnChartProps {
  title: string;
  /** One sentence saying what the chart shows, for screen readers. */
  summary: string;
  /** The groups, each with a stable key (names may repeat). */
  categories: { key: string; label: string }[];
  series: ColumnSeries[];
  format: (value: number) => string;
  /** The value of one displayed unit, for round ticks (3600 when seconds show as hours). */
  unit?: number;
  tableLabel: string;
  categoryHeader: string;
}

const HEIGHT = 220;
const M = { top: 20, right: 12, bottom: 28, left: 48 };
const BAR = 24;
const GAP = 2;
/** About the width of a character of the 12px tick text. */
const CHAR = 6.8;

/** A label in at most two lines that fit `room` pixels, broken at spaces; null when none fits. */
function fit(label: string, room: number): string[] | null {
  const max = Math.floor(room / CHAR);
  if (label.length <= max) return [label];
  const words = label.split(' ');
  for (let k = words.length - 1; k > 0; k--) {
    const first = words.slice(0, k).join(' ');
    const second = words.slice(k).join(' ');
    if (first.length <= max && second.length <= max) return [first, second];
  }
  return null;
}

/** A column of `w` by `h` from the baseline, its data end rounded by 4px (less when short). */
function column(x: number, base: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  const top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

/**
 * Grouped columns (M1-060; ADR-057), velocity's form: one group per category, at most 24px
 * per column with a 2px gap between neighbours, rounded at the data end and square at the
 * baseline, the value at each tip where it fits, a legend from two series on, the group's
 * values on hover, and the numbers as a table.
 */
export function ColumnChart({
  title,
  summary,
  categories,
  series,
  format,
  unit = 1,
  tableLabel,
  categoryHeader,
}: ColumnChartProps) {
  const id = useId();
  const [box, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = categories.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const band = plotW / Math.max(1, n);
  // Labels wrap to two lines where they must; where even that does not fit, every k-th shows
  // on one line, and the table and the tooltip still name them all.
  const fitted = categories.map((c) => fit(c.label, band - 6));
  const wraps = fitted.every((f) => f !== null) && fitted.some((f) => (f?.length ?? 0) > 1);
  const bottom = wraps ? M.bottom + 14 : M.bottom;
  const plotH = HEIGHT - M.top - bottom;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max, 4, unit);
  const top = ticks[ticks.length - 1] ?? 1;
  const bar = Math.max(4, Math.min(BAR, (band * 0.7 - GAP * (series.length - 1)) / series.length));
  const group = bar * series.length + GAP * (series.length - 1);
  const base = M.top + plotH;
  const h = (v: number) => (v / top) * plotH;
  const x0 = (i: number) => M.left + i * band + (band - group) / 2;
  // A tip label needs about its own width of room.
  const labelFits = bar >= 14;
  const widest = Math.max(1, ...categories.map((c) => c.label.length * CHAR + 8));
  const every = fitted.every((f) => f !== null) ? 1 : Math.max(1, Math.ceil(widest / band));

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="chart-title">
        {title}
      </figcaption>
      {series.length >= 2 && (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.id}>
              <span className={`chart-swatch chart-key-${s.tone}`} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={box} className="chart-plot" onPointerLeave={() => setHover(null)}>
        <svg width={width} height={HEIGHT} role="img" aria-label={summary}>
          {ticks.map((v) => (
            <g key={v}>
              <line
                className="chart-grid"
                x1={M.left}
                x2={M.left + plotW}
                y1={base - h(v)}
                y2={base - h(v)}
              />
              <text
                className="chart-tick"
                x={M.left - 8}
                y={base - h(v)}
                textAnchor="end"
                dy="0.32em"
              >
                {format(v)}
              </text>
            </g>
          ))}
          {categories.map((category, i) => (
            <g key={category.key}>
              {hover === i && (
                <rect
                  className="chart-band"
                  x={M.left + i * band}
                  y={M.top}
                  width={band}
                  height={plotH}
                />
              )}
              {series.map((s, k) => {
                const v = s.values[i] ?? 0;
                const x = x0(i) + k * (bar + GAP);
                return (
                  <g key={s.id}>
                    <path
                      className={`chart-column chart-column-${s.tone}`}
                      d={column(x, base, bar, h(v))}
                    />
                    {labelFits && (
                      <text
                        className="chart-value"
                        x={x + bar / 2}
                        y={base - h(v) - 6}
                        textAnchor="middle"
                      >
                        {format(v)}
                      </text>
                    )}
                  </g>
                );
              })}
              {i % every === 0 &&
                ((every === 1 ? fitted[i] : null) ?? [category.label]).map((line, k, lines) => (
                  <text
                    key={line}
                    className="chart-tick"
                    x={M.left + i * band + band / 2}
                    y={HEIGHT - 8 - (lines.length - 1 - k) * 14}
                    textAnchor="middle"
                  >
                    {line}
                  </text>
                ))}
              {/* The whole band is the hover target, larger than the columns in it. */}
              <rect
                className="chart-hit"
                x={M.left + i * band}
                y={M.top}
                width={band}
                height={plotH}
                onPointerEnter={() => setHover(i)}
              />
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={{ left: Math.min(M.left + hover * band + band, width - 160), top: M.top }}
          >
            <strong>{categories[hover]?.label}</strong>
            {series.map((s) => (
              <span key={s.id}>
                <span className={`chart-swatch chart-key-${s.tone}`} />
                {s.label} {format(s.values[hover] ?? 0)}
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>{tableLabel}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{categoryHeader}</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((category, i) => (
              <tr key={category.key}>
                <th scope="row">{category.label}</th>
                {series.map((s) => (
                  <td key={s.id}>{format(s.values[i] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

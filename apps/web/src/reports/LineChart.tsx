import { type PointerEvent, useId, useState } from 'react';
import { niceTicks, type Tone, useElementWidth } from './chart';

export interface LineSeries {
  id: string;
  label: string;
  /** The first or second series hue, or the neutral for a reference line. */
  tone: Tone;
  /** One value per x label; null where there is none (days still to come). */
  values: (number | null)[];
}

export interface LineChartProps {
  title: string;
  /** One sentence saying what the chart shows, for screen readers. */
  summary: string;
  /** The x axis, already formatted (dates). */
  xLabels: string[];
  series: LineSeries[];
  format: (value: number) => string;
  /** The value of one displayed unit, for round ticks (3600 when seconds show as hours). */
  unit?: number;
  /** What the values count (tickets, hours, an estimate), named over the value axis. */
  measure?: string;
  /** The table view's toggle and its first column's header. */
  tableLabel: string;
  xHeader: string;
}

const HEIGHT = 220;
const M = { top: 12, right: 64, bottom: 28, left: 48 };

/**
 * A line chart (M1-060; ADR-057): 2px lines with round ends, an end dot ringed in the surface
 * color and the series' last value beside it, recessive hairline gridlines, a legend from two
 * series on, a crosshair with the day's values on hover, and the numbers as a table for
 * keyboards, screen readers and print. Colors come from the skin's chart tokens. Where a later
 * data line runs along an earlier one, from one point to the next, that stretch of the earlier
 * line is also drawn as a wider band beneath both, so the two stay in sight where they agree (the
 * release report's scope once all of it is done); the rest of it stays a 2px line.
 */
export function LineChart({
  title,
  summary,
  xLabels,
  series,
  format,
  unit = 1,
  measure,
  tableLabel,
  xHeader,
}: LineChartProps) {
  const id = useId();
  const [box, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = xLabels.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  const max = Math.max(
    0,
    ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const ticks = niceTicks(max, 4, unit);
  const top = ticks[ticks.length - 1] ?? 1;
  const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  // As many labels as fit at their own width (about 6.8px a character), the first and last always.
  const labelWidth = Math.max(72, ...xLabels.map((l) => l.length * 6.8 + 16));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / labelWidth))));
  const shownX = xLabels
    .map((label, i) => ({ label, i }))
    .filter(({ i }) => i === 0 || i === n - 1 || (i % every === 0 && n - 1 - i >= every));

  // The stretches of a data line that a later data line covers, from one point to the next where
  // both have the same two values: only those are drawn as a wider band beneath it, so the rest of
  // the line keeps its 2px form (a quiet day at 0 and 0 does not widen a whole Created line).
  const under = series.map((s, k) => {
    if (s.tone === 'guide') return '';
    const later = series.slice(k + 1).filter((l) => l.tone !== 'guide');
    let d = '';
    let pen = false;
    for (let i = 0; i + 1 < s.values.length; i++) {
      const v = s.values[i];
      const next = s.values[i + 1];
      if (
        v === null ||
        v === undefined ||
        next === null ||
        next === undefined ||
        !later.some((l) => l.values[i] === v && l.values[i + 1] === next)
      ) {
        pen = false;
        continue;
      }
      if (!pen) d += `M${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      d += `L${x(i + 1).toFixed(1)},${y(next).toFixed(1)}`;
      pen = true;
    }
    return d;
  });
  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  // End labels of the data series; one that would sit on another is left to the legend.
  const ends: { s: LineSeries; i: number; v: number; label: boolean }[] = [];
  for (const s of series) {
    if (s.tone === 'guide') continue;
    const i = s.values.reduce<number>((last, v, k) => (v === null ? last : k), -1);
    const v = i >= 0 ? s.values[i] : null;
    if (i < 0 || v === null || v === undefined) continue;
    const clash = ends.some((e) => e.label && Math.abs(y(e.v) - y(v)) < 14);
    ends.push({ s, i, v, label: !clash });
  }

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left - M.left;
    const i = n <= 1 ? 0 : Math.round((px / plotW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="chart-title">
        {title}
      </figcaption>
      {series.length >= 2 && (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.id}>
              <span className={`chart-key chart-key-${s.tone}`} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {measure && <p className="chart-measure">{measure}</p>}
      <div
        ref={box}
        className="chart-plot"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg width={width} height={HEIGHT} role="img" aria-label={summary}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="chart-tick" x={M.left - 8} y={y(v)} textAnchor="end" dy="0.32em">
                {format(v)}
              </text>
            </g>
          ))}
          {shownX.map(({ label, i }) => (
            <text
              key={label}
              className="chart-tick"
              x={x(i)}
              y={HEIGHT - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            >
              {label}
            </text>
          ))}
          {hover !== null && (
            <line
              className="chart-crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={M.top}
              y2={M.top + plotH}
            />
          )}
          {series.map((s, k) =>
            under[k] ? (
              <path
                key={`${s.id}-under`}
                className={`chart-line chart-line-${s.tone} chart-line-under`}
                d={under[k]}
              />
            ) : null,
          )}
          {series.map((s, k) => (
            <path key={s.id} className={`chart-line chart-line-${s.tone}`} d={paths[k]} />
          ))}
          {ends.map((e) => (
            <g key={e.s.id}>
              <circle className={`chart-dot chart-dot-${e.s.tone}`} cx={x(e.i)} cy={y(e.v)} r={4} />
              {e.label && (
                <text className="chart-value" x={x(e.i) + 9} y={y(e.v)} dy="0.32em">
                  {format(e.v)}
                </text>
              )}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={{ left: Math.min(x(hover) + 12, width - 160), top: M.top }}
          >
            <strong>{xLabels[hover]}</strong>
            {series.map((s) => {
              const v = s.values[hover];
              return v === null || v === undefined ? null : (
                <span key={s.id}>
                  <span className={`chart-key chart-key-${s.tone}`} />
                  {s.label} {format(v)}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>{tableLabel}</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{xHeader}</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {xLabels.map((label, i) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {series.map((s) => {
                  const v = s.values[i];
                  return <td key={s.id}>{v === null || v === undefined ? '' : format(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

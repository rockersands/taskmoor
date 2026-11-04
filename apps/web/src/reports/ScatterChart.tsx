import { type PointerEvent, type ReactNode, useId, useState } from 'react';
import { niceTicks, useElementWidth } from './chart';

export interface ScatterPoint {
  id: string;
  /** The moment, in milliseconds. */
  x: number;
  y: number;
  /** The rolling average and standard deviation at this point. */
  average: number;
  deviation: number;
  /** Shown first in the tooltip and the table (a ticket key). */
  label: string;
  detail: string;
  /** Where the label leads (the ticket). */
  href?: string;
}

export interface ScatterChartProps {
  title: string;
  /** One sentence saying what the chart shows, for screen readers. */
  summary: string;
  points: ScatterPoint[];
  /** The x axis' span, in milliseconds, so an empty window still has its dates. */
  from: number;
  to: number;
  formatX: (ms: number) => string;
  formatY: (value: number) => string;
  /** The value of one displayed unit, for round ticks (3600 for hours from seconds). */
  unit?: number;
  labels: {
    points: string;
    average: string;
    band: string;
    table: string;
    /** Column headers of the table: the label, the moment, y, the average. */
    headers: [string, string, string, string];
  };
  /** Shown above the table when only the newest points are listed. */
  note?: ReactNode;
}

const HEIGHT = 260;
const M = { top: 12, right: 16, bottom: 28, left: 52 };
/** How near the pointer must come to a dot to show it, in pixels. */
const REACH = 24;

/**
 * A scatter over time with a rolling average (M1-061; ADR-058), the control chart's form: a dot
 * per ticket (8px, ringed in the surface so clusters stay readable), the rolling average as a
 * 2px line in the second hue with its standard deviation as a 12% wash, the nearest dot's ticket
 * and values on hover, and every point as a table with links.
 */
export function ScatterChart({
  title,
  summary,
  points,
  from,
  to,
  formatX,
  formatY,
  unit = 1,
  labels,
  note,
}: ScatterChartProps) {
  const id = useId();
  const [box, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(40, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  const max = Math.max(0, ...points.map((p) => Math.max(p.y, p.average + p.deviation)));
  const ticks = niceTicks(max, 4, unit);
  const top = ticks[ticks.length - 1] ?? 1;
  const span = Math.max(1, to - from);
  const x = (ms: number) => M.left + ((ms - from) / span) * plotW;
  const y = (v: number) => M.top + plotH - (Math.max(0, v) / top) * plotH;
  const count = Math.max(2, Math.min(6, Math.floor(plotW / 96)));
  const xTicks = Array.from({ length: count }, (_, i) => from + (i * span) / (count - 1));

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(1)},${y(p.average).toFixed(1)}`)
    .join('');
  const band =
    points.length === 0
      ? ''
      : `${points
          .map(
            (p, i) =>
              `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(1)},${y(p.average + p.deviation).toFixed(1)}`,
          )
          .join('')}${[...points]
          .reverse()
          .map((p) => `L${x(p.x).toFixed(1)},${y(p.average - p.deviation).toFixed(1)}`)
          .join('')}Z`;

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best = -1;
    let bestDistance = REACH * REACH;
    points.forEach((p, i) => {
      const d = (x(p.x) - px) ** 2 + (y(p.y) - py) ** 2;
      if (d <= bestDistance) {
        best = i;
        bestDistance = d;
      }
    });
    setHover(best < 0 ? null : best);
  };
  const hovered = hover === null ? null : points[hover];

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="chart-title">
        {title}
      </figcaption>
      <ul className="chart-legend">
        <li>
          <span className="chart-swatch chart-swatch-round chart-key-one" aria-hidden="true" />
          {labels.points}
        </li>
        <li>
          <span className="chart-key chart-key-two" aria-hidden="true" />
          {labels.average}
        </li>
        <li>
          <span className="chart-swatch chart-swatch-wash" aria-hidden="true" />
          {labels.band}
        </li>
      </ul>
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
                {formatY(v)}
              </text>
            </g>
          ))}
          {xTicks.map((ms, i) => (
            <text
              key={ms}
              className="chart-tick"
              x={x(ms)}
              y={HEIGHT - 8}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            >
              {/* The right edge is the end of the last moment: it reads as that day. */}
              {formatX(i === xTicks.length - 1 ? Math.max(from, ms - 1) : ms)}
            </text>
          ))}
          <path className="chart-wash-two" d={band} />
          {points.map((p) => (
            <circle key={p.id} className="chart-dot chart-dot-one" cx={x(p.x)} cy={y(p.y)} r={4} />
          ))}
          <path className="chart-line chart-line-two" d={line} />
          {hovered && (
            <circle className="chart-dot-focus" cx={x(hovered.x)} cy={y(hovered.y)} r={7} />
          )}
        </svg>
        {hovered && (
          <div
            className="chart-tooltip chart-tooltip-wrap"
            aria-hidden="true"
            style={{
              left: Math.max(0, Math.min(x(hovered.x) + 12, width - 220)),
              top: M.top,
            }}
          >
            <strong>{hovered.label}</strong>
            <span>{hovered.detail}</span>
            <span>
              {labels.headers[1]} {formatX(hovered.x)}
            </span>
            <span>
              <span className="chart-swatch chart-swatch-round chart-key-one" />
              {labels.headers[2]} {formatY(hovered.y)}
            </span>
            <span>
              <span className="chart-key chart-key-two" />
              {labels.headers[3]} {formatY(hovered.average)}
            </span>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>{labels.table}</summary>
        {note}
        <table className="data-table">
          <thead>
            <tr>
              {labels.headers.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.href ? <a href={p.href}>{p.label}</a> : p.label}</th>
                <td>{formatX(p.x)}</td>
                <td>{formatY(p.y)}</td>
                <td>{formatY(p.average)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

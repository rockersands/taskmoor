import { type CSSProperties, type PointerEvent, useId, useState } from 'react';
import { niceTicks, useElementWidth } from './chart';

export interface AreaLayer {
  id: string;
  label: string;
  /** One value per x label. */
  values: number[];
}

export interface StackedAreaChartProps {
  title: string;
  /** One sentence saying what the chart shows, for screen readers. */
  summary: string;
  /** The x axis, already formatted (dates). */
  xLabels: string[];
  /** Ordered stages, first to last; the last lies at the bottom of the stack. */
  layers: AreaLayer[];
  format: (value: number) => string;
  tableLabel: string;
  xHeader: string;
}

const HEIGHT = 240;
const M = { top: 12, right: 16, bottom: 28, left: 48 };

/** A stage's fill: the ordered ramp from the first stage's blue to the last's, mixed in oklab. */
export function stageFill(index: number, count: number): CSSProperties {
  if (count <= 1) return { fill: 'var(--color-flow-last)' };
  const first = Math.round((1 - index / (count - 1)) * 100);
  return {
    fill: `color-mix(in oklab, var(--color-flow-first) ${first}%, var(--color-flow-last))`,
  };
}

/**
 * Stacked areas of ordered stages (M1-061; ADR-058), cumulative flow's form: the last stage at
 * the bottom so finished work grows from the baseline, one blue from light to dark by stage
 * order (an ordinal ramp, never a hue per stage), a 2px surface line between neighbours, a
 * legend, every stage's value for the day under the pointer, and the numbers as a table.
 */
export function StackedAreaChart({
  title,
  summary,
  xLabels,
  layers,
  format,
  tableLabel,
  xHeader,
}: StackedAreaChartProps) {
  const id = useId();
  const [box, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = xLabels.length;
  const plotW = Math.max(40, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  // Bottom to top: the last stage first.
  const stack = [...layers].reverse();
  const tops: number[][] = [];
  let running = new Array<number>(n).fill(0);
  for (const layer of stack) {
    running = running.map((v, i) => v + (layer.values[i] ?? 0));
    tops.push(running);
  }
  const max = Math.max(0, ...(tops[tops.length - 1] ?? [0]));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] ?? 1;
  const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  // As many labels as fit at their own width (about 6.8px a character), the first and last always.
  const labelWidth = Math.max(72, ...xLabels.map((l) => l.length * 6.8 + 16));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / labelWidth))));
  const shownX = xLabels
    .map((label, i) => ({ label, i }))
    .filter(({ i }) => i === 0 || i === n - 1 || (i % every === 0 && n - 1 - i >= every));
  const area = (k: number) => {
    const upper = tops[k] ?? [];
    const lower = k === 0 ? new Array<number>(n).fill(0) : (tops[k - 1] ?? []);
    if (n === 1) {
      const x0 = M.left;
      const x1 = M.left + plotW;
      return `M${x0},${y(upper[0] ?? 0)}H${x1}V${y(lower[0] ?? 0)}H${x0}Z`;
    }
    const along = upper.map(
      (v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`,
    );
    const back = lower
      .map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .reverse()
      .join('');
    return `${along.join('')}${back}Z`;
  };

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
      {layers.length >= 2 && (
        <ul className="chart-legend">
          {layers.map((l, i) => (
            <li key={l.id}>
              <svg className="chart-swatch-svg" width="10" height="10" aria-hidden="true">
                <rect width="10" height="10" rx="2" style={stageFill(i, layers.length)} />
              </svg>
              {l.label}
            </li>
          ))}
        </ul>
      )}
      <div
        ref={box}
        className="chart-plot"
        onPointerMove={n > 0 ? onMove : undefined}
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
          {n > 0 &&
            stack.map((layer, k) => (
              <path
                key={layer.id}
                className="chart-area"
                d={area(k)}
                style={stageFill(layers.length - 1 - k, layers.length)}
              />
            ))}
          {shownX.map(({ label, i }) => (
            <text
              key={label}
              className="chart-tick"
              x={x(i)}
              y={HEIGHT - 8}
              textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
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
        </svg>
        {hover !== null && (
          <div
            className="chart-tooltip"
            aria-hidden="true"
            style={{ left: Math.max(0, Math.min(x(hover) + 12, width - 180)), top: M.top }}
          >
            <strong>{xLabels[hover]}</strong>
            {layers.map((l, i) => (
              <span key={l.id}>
                <svg className="chart-swatch-svg" width="10" height="10" aria-hidden="true">
                  <rect width="10" height="10" rx="2" style={stageFill(i, layers.length)} />
                </svg>
                {l.label} {format(l.values[hover] ?? 0)}
              </span>
            ))}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>{tableLabel}</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{xHeader}</th>
              {layers.map((l) => (
                <th key={l.id} scope="col">
                  {l.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {xLabels.map((label, i) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {layers.map((l) => (
                  <td key={l.id}>{format(l.values[i] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

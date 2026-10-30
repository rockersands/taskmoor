import { useId, useState } from 'react';

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
}

export interface DonutChartProps {
  title: string;
  /** One sentence saying what the chart shows, for screen readers. */
  summary: string;
  /** At most six, in the order to draw; the caller folds the rest into one. */
  slices: DonutSlice[];
  format: (value: number) => string;
  /** A share of the whole, already formatted (`12%`). */
  formatShare: (share: number) => string;
  /** A slice's value and share together, as the legend and the tooltip say them. */
  formatEntry: (value: number, share: number) => string;
  tableLabel: string;
  headers: [string, string, string];
}

export const MAX_SLICES = 6;
const SIZE = 168;
const STROKE = 28;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;
/** The surface gap between neighbouring slices, in pixels along the ring. */
const GAP = 2;

/**
 * Shares of a whole (M1-064; ADR-060), the pie widget's form: a ring of at most six slices in
 * the categorical hues' fixed order, a 2px surface gap between them, every slice's value and
 * share beside its swatch in the legend (so no hue has to be told apart unaided), the slice
 * under the pointer raised with its numbers, and the numbers as a table.
 */
export function DonutChart({
  title,
  summary,
  slices,
  format,
  formatShare,
  formatEntry,
  tableLabel,
  headers,
}: DonutChartProps) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const shown = slices.slice(0, MAX_SLICES);
  const total = shown.reduce((s, x) => s + x.value, 0);
  let offset = 0;
  const arcs = shown.map((slice, i) => {
    const length = total === 0 ? 0 : (slice.value / total) * CIRCUMFERENCE;
    const arc = { slice, i, start: offset, length };
    offset += length;
    return arc;
  });
  const share = (v: number) => (total === 0 ? 0 : v / total);
  const hovered = hover === null ? null : shown[hover];

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="chart-title">
        {title}
      </figcaption>
      <div className="chart-donut">
        <div className="chart-plot">
          <svg width={SIZE} height={SIZE} role="img" aria-label={summary}>
            <circle className="chart-donut-track" cx={SIZE / 2} cy={SIZE / 2} r={R} />
            {arcs.map(({ slice, i, start, length }) =>
              length <= 0 ? null : (
                <circle
                  key={slice.id}
                  className={`chart-donut-slice chart-tone-${i + 1}${hover === i ? ' is-raised' : ''}`}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={R}
                  strokeDasharray={`${Math.max(0.5, length - (shown.length > 1 ? GAP : 0))} ${CIRCUMFERENCE}`}
                  strokeDashoffset={-start}
                  transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              ),
            )}
          </svg>
          {hovered && (
            <div className="chart-tooltip chart-donut-tip" aria-hidden="true">
              <strong>{hovered.label}</strong>
              <span>{formatEntry(hovered.value, share(hovered.value))}</span>
            </div>
          )}
        </div>
        <ul className="chart-legend chart-legend-list">
          {shown.map((slice, i) => (
            <li key={slice.id}>
              <span className={`chart-swatch chart-tone-${i + 1}`} aria-hidden="true" />
              <span className="chart-legend-label">{slice.label}</span>
              <span className="chart-legend-value">
                {formatEntry(slice.value, share(slice.value))}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <details className="chart-table">
        <summary>{tableLabel}</summary>
        <table>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((slice) => (
              <tr key={slice.id}>
                <th scope="row">{slice.label}</th>
                <td>{format(slice.value)}</td>
                <td>{formatShare(share(slice.value))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

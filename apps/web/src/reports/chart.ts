import { useLayoutEffect, useRef, useState } from 'react';

/**
 * What the charts share (M1-060): clean axis ticks and the width of the box a chart draws in.
 * Charts draw at their box's width in pixels, so text stays its size on a phone.
 */

/**
 * Round ticks from 0 to at least `max`, about `count` of them, in steps of 1, 2, 2.5 or 5 times
 * a power of ten. `unit` is the value of one displayed unit (3600 for hours shown from seconds),
 * so time reads in whole and half hours.
 */
export function niceTicks(max: number, count = 4, unit = 1): number[] {
  const top = max / unit;
  if (!(top > 0)) return [0, unit];
  const raw = top / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v < top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if ((ticks[ticks.length - 1] ?? 0) < top) ticks.push((ticks[ticks.length - 1] ?? 0) + step);
  return ticks.map((v) => v * unit);
}

/** The width of an element, following it as it resizes; `fallback` where nothing measures. */
export function useElementWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(240, Math.floor(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Chart colors by role; the values are skin tokens (`--color-chart-*`). */
export type Tone = 'one' | 'two' | 'guide';

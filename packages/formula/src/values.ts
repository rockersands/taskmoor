import { isDay, isoOfDay } from './calendar';
import { LIMITS } from './lexer';
import { type OutputType, outputValueType, type Scalar, type ValueType } from './program';

/**
 * Turning values into text and into what a field stores. Numbers keep at most three decimals
 * and the range of number fields (CORE-010 (1)); anything outside is empty, never an error.
 */
export const NUMBER_LIMIT = 1e12;
/** Characters a text output keeps (as short text fields, spec 01a section 1.4). */
export const TEXT_OUTPUT_MAX = 255;

/**
 * A number rounded half away from zero to `digits` decimals (negative: tens, hundreds), on its
 * shortest decimal form, so 1.005 rounds to 1.01 although its binary double lies below.
 */
export function roundTo(x: number, digits: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(digits)) return null;
  const d = Math.max(-15, Math.min(15, Math.trunc(digits)));
  const scale = 10 ** d;
  const scaled = Number((Math.abs(x) * scale).toPrecision(15));
  if (!Number.isFinite(scaled)) return null;
  const r = (Math.sign(x) * Math.floor(scaled + 0.5)) / scale;
  if (!Number.isFinite(r)) return null;
  return r === 0 ? 0 : r;
}

/** Floor and ceiling on the shortest decimal form, so 0.1 * 30 is 3 for both. */
export function floorOf(x: number): number {
  return Math.floor(Number(x.toPrecision(15)));
}
export function ceilOf(x: number): number {
  return Math.ceil(Number(x.toPrecision(15)));
}

/** A number as text: at most three decimals, no trailing zeros. */
export function formatNumber(x: number): string {
  const r = roundTo(x, 3);
  return r === null ? '' : String(r);
}

/** A duration as text: hours and minutes ("26h 30m", "45m", "0m"). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : ''].filter(Boolean);
  const text = parts.length === 0 ? '0m' : parts.join(' ');
  return seconds < 0 && minutes > 0 ? `-${text}` : text;
}

/** A value of a type as text; empty is the empty text. */
export function formatValue(value: Scalar, type: ValueType): string {
  if (value === null) return '';
  switch (type) {
    case 'number':
      return formatNumber(value as number);
    case 'date':
      return isDay(value as number) ? isoOfDay(value as number) : '';
    case 'duration':
      return formatDuration(value as number);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return String(value);
  }
}

/**
 * What a formula field stores for a value (ADR-008 forms): a number within plus or minus 10^12
 * at 0.001; whole seconds for a duration; `YYYY-MM-DD` for a date; one line of at most 255
 * characters for text. Undefined is empty: the field has no value.
 */
export function storedValue(output: OutputType, value: Scalar): number | string | undefined {
  if (value === null) return undefined;
  switch (outputValueType(output)) {
    case 'number': {
      if (typeof value !== 'number') return undefined;
      const r = roundTo(value, 3);
      return r === null || Math.abs(r) > NUMBER_LIMIT ? undefined : r;
    }
    case 'duration': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      const s = Math.round(value);
      return Math.abs(s) > NUMBER_LIMIT ? undefined : s === 0 ? 0 : s;
    }
    case 'date':
      return typeof value === 'number' && isDay(value) ? isoOfDay(value) : undefined;
    case 'text': {
      if (typeof value !== 'string') return undefined;
      const line = value
        .slice(0, LIMITS.text)
        .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
        .trim();
      const kept = [...line].slice(0, TEXT_OUTPUT_MAX).join('').trim();
      return kept === '' ? undefined : kept;
    }
  }
}

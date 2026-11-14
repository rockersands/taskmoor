import type { CSSProperties } from 'react';
import { IconSelect } from './IconSelect';

/** A track as a picker offers it: its key and name, and the colour its administrators gave it. */
export interface TrackOption {
  id: number;
  key: string;
  name: string;
  color?: string | null | undefined;
}

/**
 * A track's mark beside its name (CORE-001): the first letter of its key on a tile edged in the
 * track's colour, when it has one. Decorative: the words beside it name the track, so colour never
 * carries meaning on its own.
 */
export function TrackGlyph({
  trackKey,
  color,
}: {
  trackKey: string;
  color?: string | null | undefined;
}) {
  const style = color ? ({ '--track-color': color } as CSSProperties) : undefined;
  return (
    <span className="track-glyph" aria-hidden="true" style={style}>
      {trackKey.slice(0, 1)}
    </span>
  );
}

export interface TrackSelectProps {
  id?: string | undefined;
  tracks: readonly TrackOption[];
  /** The chosen track's key. */
  value: string;
  onChange: (key: string) => void;
  /** Each option's words, from the caller's own catalogue entry: "PAY Payments". */
  label: (track: TrackOption) => string;
  disabled?: boolean | undefined;
  'aria-describedby'?: string | undefined;
}

/**
 * Choosing a track (T-255): the app's icon select, each option with the track's mark, key and
 * name. It stays a combobox named by its form label, with the keyboard of `IconSelect`.
 */
export function TrackSelect({
  id,
  tracks,
  value,
  onChange,
  label,
  disabled,
  'aria-describedby': describedBy,
}: TrackSelectProps) {
  return (
    <IconSelect
      id={id}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      options={tracks.map((track) => ({
        value: track.key,
        label: label(track),
        icon: <TrackGlyph trackKey={track.key} color={track.color} />,
      }))}
      onChange={onChange}
    />
  );
}

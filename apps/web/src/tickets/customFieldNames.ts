import { useCallback, useEffect, useRef } from 'react';
import { type CustomFieldNames, customFieldOf } from './refusedFields';

/** A custom field by its id and name, as the field catalogue lists it. */
export interface NamedField {
  id: number;
  name: string;
}

/** Reads the custom fields of a track (by its id) from the field catalogue. */
export type ReadFieldNames = (trackId: number) => Promise<NamedField[]>;

/**
 * Gives `show` the names of the custom fields that `keys` name (`fields.12`, `cf[12]`), so a
 * refusal names them as people see them (T-297).
 */
export type NameCustomFields = (
  keys: Iterable<string>,
  show: (names: CustomFieldNames) => void,
) => void;

const NONE: CustomFieldNames = new Map();

/**
 * The names of the custom fields a refusal names, for a page that has no field catalogue of its
 * own, or one with only some fields (T-297). The page's own names (`known`) answer first; for any
 * other field the track's catalogue is read the first time a refusal needs it and kept for as long
 * as the page is open, so a later refusal is named at once.
 *
 * `show` is called at once when nothing needs reading, else when the read is done. A field the
 * catalogue does not give (a read refused or failed, for example without permission) keeps the
 * helper's 'A custom field'; a failed read is tried again on the next refusal. Of two refusals
 * waiting on the read only the later is shown, and nothing is shown once the page is gone.
 */
export function useCustomFieldNames(
  trackId: number | null,
  read: ReadFieldNames | undefined,
  known: CustomFieldNames = NONE,
): NameCustomFields {
  /** The catalogue's names, for the track it was read for. */
  const catalogue = useRef<{ trackId: number; names: CustomFieldNames } | null>(null);
  /** The read under way, shared by refusals that come while it lasts. */
  const reading = useRef<{ trackId: number; names: Promise<CustomFieldNames | null> } | null>(null);
  const latest = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  return useCallback(
    (keys, show) => {
      const call = ++latest.current;
      const withKnown = (names: CustomFieldNames | null) =>
        names === null || names.size === 0 ? known : new Map([...names, ...known]);
      const have = catalogue.current?.trackId === trackId ? catalogue.current.names : null;
      const unnamed = [...keys]
        .map(customFieldOf)
        .some((id) => id !== null && !known.has(id) && !have?.has(id));
      // Nothing to read: every field is named, the catalogue was read already, or cannot be.
      if (!unnamed || have !== null || trackId === null || read === undefined) {
        show(withKnown(have));
        return;
      }
      let pending = reading.current?.trackId === trackId ? reading.current.names : null;
      if (pending === null) {
        const names = read(trackId).then(
          (fields): CustomFieldNames => {
            const found = new Map(fields.map((field) => [field.id, field.name]));
            catalogue.current = { trackId, names: found };
            return found;
          },
          () => null,
        );
        reading.current = { trackId, names };
        void names.finally(() => {
          if (reading.current?.names === names) reading.current = null;
        });
        pending = names;
      }
      void pending.then((names) => {
        if (live.current && call === latest.current) show(withKnown(names));
      });
    },
    [trackId, read, known],
  );
}

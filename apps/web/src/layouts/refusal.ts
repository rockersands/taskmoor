import type { Translate } from '../i18n/I18nProvider';
import { MAX_SECTIONS, MAX_TAB_NAME, MAX_TABS } from './model';

/**
 * Why the server refused layouts, in the catalogue's words (UI-T15; CORE-013): the refusals a
 * save's checks make that the editor can meet (the layout schema and `checkLayouts`, in
 * `apps/server/src/fields`), told by the place the server names and its own wording there. Null
 * for any other refusal, which the caller then puts in general terms: the server's detail is
 * English with the request's paths in it, so it is never shown as it comes.
 *
 * `nameOf` gives a custom field's name when the page knows it; the key stands in otherwise.
 */
export function layoutRefusal(
  t: Translate,
  body: unknown,
  nameOf: (key: string) => string | undefined,
): string | null {
  const { error, detail } = (body ?? {}) as { error?: unknown; detail?: unknown };
  if (error === 'unknown_ticket_type') return t('layouts.refusal.unknownType');
  if (typeof detail !== 'string') return null;
  const field = (key: string) => nameOf(key) ?? key;
  // The schema's answer is `<path>: <message>`, its issues joined by "; "; `checkLayouts` says
  // one thing with no path.
  for (const issue of detail.split('; ')) {
    const unknown = /^unknown field (\S+)$/.exec(issue)?.[1];
    if (unknown) return t('layouts.refusal.unknownField', { field: field(unknown) });
    const elsewhere = /^(\S+) belongs to another track$/.exec(issue)?.[1];
    if (elsewhere) return t('layouts.refusal.otherTrack', { field: field(elsewhere) });
    const colon = issue.indexOf(': ');
    if (colon < 0) continue;
    const place = issue.slice(0, colon);
    const message = issue.slice(colon + 2);
    if (/(^|\.)definition$/.test(place) && message === 'each field once') {
      return t('layouts.refusal.fieldTwice');
    }
    if (/(^|\.)tabs\.\d+\.name$/.test(place)) {
      return t('layouts.refusal.tabName', { count: MAX_TAB_NAME });
    }
    if (/(^|\.)tabs\.\d+\.sections$/.test(place)) {
      return t('layouts.refusal.tooManySections', { count: MAX_SECTIONS });
    }
    if (/(^|\.)definition\.tabs$/.test(place)) {
      return t('layouts.refusal.tooManyTabs', { count: MAX_TABS });
    }
  }
  return null;
}

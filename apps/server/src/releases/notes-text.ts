/**
 * The fixed text of a release's notes in each language Taskmoor ships (T-283; NFR-006): the
 * sentence that dates the release, the day itself, and the names of the seeded ticket types,
 * which are stored in English. The notes follow the language the reader's page is shown in
 * (`?locale=`), else the language saved on their account, else English; never the browser's
 * Accept-Language, since the app does not pick a draft catalogue from it either. Names people
 * gave (a type renamed or added, summaries, the description) stay as they wrote them.
 *
 * The Spanish type names are the web catalogue's (`ticketType.name.*` in messages.es.ts); a test
 * there checks they agree, so the file says what the page shows.
 */
export type NotesLanguage = 'en' | 'es';

interface NotesText {
  released: string;
  planned: string;
  /** The seeded types' stored (English) names in this language; absent ones stay as stored. */
  types: Readonly<Record<string, string>>;
}

const TEXT: Readonly<Record<NotesLanguage, NotesText>> = {
  en: {
    released: 'Released on {day}.',
    planned: 'Planned for {day}.',
    types: {},
  },
  es: {
    released: 'Entregada el {day}.',
    planned: 'Prevista para el {day}.',
    types: {
      Outcome: 'Objetivo',
      Feature: 'Funcionalidad',
      Bug: 'Error',
      Chore: 'Tarea',
      'To-do': 'Pendiente',
      Idea: 'Idea',
      Subticket: 'Subticket',
    },
  },
};

/** The language a BCP 47 tag asks for, when the notes are written in it. */
function languageOf(tag: string | null | undefined): NotesLanguage | null {
  const language = (tag ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  return language === 'en' || language === 'es' ? language : null;
}

/**
 * The notes' language: the one asked for (the page's), else the account's saved one, else
 * English. A tag in a language the notes are not written in counts as English, not as unset:
 * the page asking for it is shown in English too.
 */
export function notesLanguage(
  asked: string | null | undefined,
  saved: string | null | undefined,
): NotesLanguage {
  if (asked) return languageOf(asked) ?? 'en';
  return languageOf(saved) ?? 'en';
}

const longDays = new Map<NotesLanguage, Intl.DateTimeFormat>();

/**
 * A calendar day as the notes write it, in words: 'October 1, 2026', '1 de octubre de 2026',
 * never `2026-10-01` (T-277). Read on UTC's clock, as a calendar day has no time of day.
 */
export function notesDay(language: NotesLanguage, day: string): string {
  let format = longDays.get(language);
  if (!format) {
    format = new Intl.DateTimeFormat(language === 'es' ? 'es' : 'en-US', {
      timeZone: 'UTC',
      dateStyle: 'long',
    });
    longDays.set(language, format);
  }
  return format.format(new Date(`${day}T00:00:00Z`));
}

/** 'Released on {day}.' in the notes' language. */
export const releasedOn = (language: NotesLanguage, day: string) =>
  TEXT[language].released.replace('{day}', notesDay(language, day));

/** 'Planned for {day}.' in the notes' language. */
export const plannedFor = (language: NotesLanguage, day: string) =>
  TEXT[language].planned.replace('{day}', notesDay(language, day));

/** A ticket type's name as a section of the notes heads it: a seeded one in the language. */
export function notesTypeName(language: NotesLanguage, stored: string): string {
  const types = TEXT[language].types;
  return Object.hasOwn(types, stored) ? (types[stored] as string) : stored;
}

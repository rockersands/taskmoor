/**
 * `docs/plan/tickets.md` read as the demo's tickets (T-239): one row per ticket, each in the
 * Backend (BE), Front (FE) or Flutter (FL) track by the section it sits in. These are the rules
 * the hand-made loads used (T-198, and the Mac's of 2026-11-06), kept here so a rerun splits the
 * same way.
 */

export type DemoTrackKey = 'BE' | 'FE' | 'FL';

export const DEMO_TRACKS: Record<DemoTrackKey, { name: string; description: string }> = {
  BE: { name: 'Backend', description: 'Server, data, operations, release and going public' },
  FE: { name: 'Front', description: 'The web app: pages, boards, tickets, search and the look' },
  FL: { name: 'Flutter', description: 'The Flutter mobile app (stopped for now)' },
};

export const DEMO_TRACK_KEYS = Object.keys(DEMO_TRACKS) as DemoTrackKey[];

/** Sections whose tickets are all about the web app. */
const FRONT_SECTIONS: ReadonlySet<string> = new Set([
  'Navigation and tracks',
  'Boards and moving tickets',
  'Tickets',
  'Search and dashboards',
  'The look',
  'The rest of the interface work',
]);

/** In "Known gaps found along the way": words that make a gap the web app's. */
const FRONT_WORDS =
  /\.tsx|apps\/web|\bpages?\b|panel|editor|focus|screen ?reader|stor(y|ies)|button|drag|phone|breadcrumb|menu|unseen|keyboard|\bshows?\b|calendar|board:/i;

/** Borderline gaps placed by hand. */
export const TRACK_OVERRIDES: Readonly<Record<string, DemoTrackKey>> = {
  'T-200': 'FE',
  'T-202': 'FE',
  'T-216': 'FE',
  'T-231': 'FE',
  'T-197': 'BE',
  'T-234': 'BE',
};

export interface TicketRow {
  /** `T-123` or `T-089e`. */
  id: string;
  summary: string;
  /** As written: Done, In progress, To do, You, Later, On branch... */
  state: string;
  notes: string;
  section: string;
  track: DemoTrackKey;
}

/** The track a row goes to. */
export function trackFor(row: Omit<TicketRow, 'track' | 'state'>): DemoTrackKey {
  const override = TRACK_OVERRIDES[row.id];
  if (override) return override;
  if (row.section.startsWith('Flutter')) return 'FL';
  if (FRONT_SECTIONS.has(row.section)) return 'FE';
  if (row.section.startsWith('Known gaps') && FRONT_WORDS.test(`${row.summary} ${row.notes}`)) {
    return 'FE';
  }
  return 'BE';
}

const ROW = /^\|\s*(T-\d+[a-z]?)\s*\|(.*?)\|(.*?)\|(.*)\|\s*$/;

/** Every ticket row under a `## ` section, in file order; a repeated id keeps its first row. */
export function parseTicketsFile(text: string): TicketRow[] {
  const rows: TicketRow[] = [];
  const seen = new Set<string>();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    const m = ROW.exec(line);
    if (!m || !section) continue;
    const [, id, summary, state, notes] = m as unknown as [string, string, string, string, string];
    if (seen.has(id)) continue;
    seen.add(id);
    const base = { id, summary: summary.trim(), notes: notes.trim(), section };
    rows.push({ ...base, state: state.trim(), track: trackFor(base) });
  }
  return rows;
}

/** The stage a state's ticket stands in: Done is closed, In progress is active, the rest new. */
export type Stage = 'new' | 'active' | 'closed';
export function stageFor(state: string): Stage {
  return state === 'Done' ? 'closed' : state === 'In progress' ? 'active' : 'new';
}

/** Labels the loader owns for a state; a rerun swaps them when the state changed. */
export const STATE_LABELS = ['needs-you', 'later'] as const;
export function stateLabels(state: string): string[] {
  return state === 'You' ? ['needs-you'] : state === 'Later' ? ['later'] : [];
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The labels a new ticket gets: its section, then its state's. */
export function labelsFor(row: TicketRow): string[] {
  return [slug(row.section), ...stateLabels(row.state)];
}

/** `T-123 · summary`, within the summary's length. */
export function summaryFor(row: TicketRow): string {
  return `${row.id} · ${row.summary}`.slice(0, 250);
}

/** The T id a loaded ticket's summary starts with, or null for any other ticket. */
export function loadedId(summary: string): string | null {
  return /^(T-\d+[a-z]?) · /.exec(summary)?.[1] ?? null;
}

/**
 * The notes as Markdown, and where they came from. The state is not written here: the status
 * and labels carry it, and a rerun keeps those current.
 */
export function descriptionFor(row: TicketRow): string {
  return `${row.notes}\n\nFrom \`docs/plan/tickets.md\`, section *${row.section}*.`;
}

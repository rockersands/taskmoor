/**
 * The design guard's two lists (design.test.ts, ADR-114, T-144).
 *
 * OFFENDERS is the work left: how many times each file breaks each rule today, or which route pages
 * have no PageHeader. Each pass over a page lowers its entries, and the guard fails until an entry
 * says exactly what is there, so the list can only shrink. An empty OFFENDERS is the finish line.
 * Never raise a number to get past the guard: fix what it names.
 *
 * ALLOWED is what stays for good, each with its reason. An entry is one file and the one thing in
 * it, or for opaque surfaces one selector, so nothing new gets through under it.
 */
export type Ratchet = Record<string, number>;

const SAMPLE_DATA = 'data a person or a test works with, not a style';
const CARET =
  'a caret colour is sent to the others in the editor, where a variable of this page means nothing';
const STICKY = 'a sticky cell: rows scroll under it, so glass would show them through its text';
const SKIN_PREVIEW = 'a miniature of a skin, drawn in the colours it shows, with no text on it';
const PANEL_LINE =
  'one line in a panel whose heading already says what it holds; a picture is too loud';

export const ALLOWED = {
  /** `<file> <literal>`: colours that are data, not styles. */
  rawColours: {
    'boards/BoardSettingsPage.tsx #2f6fdb': SAMPLE_DATA,
    'boards/fixtures.ts #2f6fdb': SAMPLE_DATA,
    'boards/fixtures.ts #c4314b': SAMPLE_DATA,
    'builder/form.ts #6d5bd0': 'the accent a kit starts with, written into what the Builder makes',
    'richtext/CollaborativeEditor.tsx #a1452a': CARET,
    'richtext/CollaborativeEditor.tsx #2f5f8f': CARET,
    'richtext/CollaborativeEditor.tsx #9b3550': CARET,
    'richtext/CollaborativeEditor.tsx #2c6a44': CARET,
    'richtext/CollaborativeEditor.tsx #6a55d4': CARET,
    'richtext/CollaborativeEditor.tsx #7a5a00': CARET,
  },
  /** Selectors: fields need no entry. The user is still to decide on sticky cells (T-143). */
  opaqueSurfaces: {
    '.skip-link': 'it appears over anything at all, and must stay readable there',
    '.timeline-head': STICKY,
    '.timeline-corner': STICKY,
    '.timeline-label': STICKY,
    '.timeline-group .timeline-label': STICKY,
    '.capacity-table thead th': STICKY,
    '.capacity-table tbody th': STICKY,
    '.capacity-row.is-team th': STICKY,
    '.skin-preview-bar': SKIN_PREVIEW,
    '.skin-preview-card': SKIN_PREVIEW,
  },
  /** `<file> <tag>`: a page title that PageHeader cannot draw. */
  titles: {
    'shell/PageHeader.tsx h1': 'the one place',
    'tickets/view/TicketPage.tsx h1':
      'the title is the summary, edited in place, a form of its own',
    'tickets/CreateTicketPage.tsx h2': 'the same form in a dialog, under the page it opened over',
  },
  /** Components: a route page that draws its header some other way. */
  pagesWithoutHeader: {
    TicketPage: 'the title is the summary, edited in place; the user decides on its purpose line',
  },
  /** `<file> <message ID>`: a short "none yet" that stays a sentence. */
  bareEmpties: {
    'admin/imports/PeopleMapping.tsx admin.imports.people.none': PANEL_LINE,
    'attachments/AttachmentPanel.tsx attachments.empty': PANEL_LINE,
    'comments/CommentsPanel.tsx comments.empty': PANEL_LINE,
    'layouts/LayoutCanvas.tsx layouts.sectionEmpty': PANEL_LINE,
    'layouts/LayoutEditorPage.tsx layouts.source.none': PANEL_LINE,
    'releases/ReleasePage.tsx release.notes.empty': PANEL_LINE,
    'richtext/CollaborativeEditor.tsx richtext.collab.empty': 'what a blank document shows to read',
    'sprints/CompleteSprint.tsx sprints.completeDialog.empty': PANEL_LINE,
    'tickets/view/ActivityPanel.tsx ticketView.history.empty': PANEL_LINE,
    'tickets/view/ActivityPanel.tsx ticketView.time.empty': PANEL_LINE,
  },
} satisfies Record<string, Record<string, string>>;

export const OFFENDERS = {
  /** Panels and wells on an opaque token; `--glass-surface-sunken` is the like-for-like glass. */
  opaqueSurfaces: {
    'styles/shell.css': 3,
  } as Ratchet,
  /** `h1` or `.page-title` outside PageHeader. */
  titles: {} as Ratchet,
  /** Route pages with no PageHeader; a purpose is ready in messages.en.ts (`purpose.*`, an intro). */
  pagesWithoutHeader: [] as string[],
  noPurpose: {} as Ratchet,
  /** `<button>` or `<table>` with no class and no rule through a parent. */
  bareControls: {} as Ratchet,
  /** `<fieldset>` classes that no stylesheet names. */
  fieldsetsWithoutRule: {} as Ratchet,
  /** "None" sentences in `.page-note` or `.report-empty`; bodies are ready as `empty.*`. */
  bareEmpties: {} as Ratchet,
  /** Raw colours; there are none left to fix. */
  rawColours: {} as Ratchet,
};

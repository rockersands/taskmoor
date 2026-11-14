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
const FACT = 'a fact with no value, beside others that have one';
const SETTING_HINT = 'a hint on a setting, about sections left empty: no list is empty here';
const PRINTED =
  'a Timeline image: fixed light colours chosen for print, since the skin must not change a file';
const GOOGLE_MARK =
  "Google's G on its sign-in button (T-061): the colours Google requires, which no skin may change";
const CARET_MENU = 'a line in the small menu at the caret, which closes as the person types on';
const NO_CHOICE = 'a setting with nothing to choose from, said beside or in place of its picker';
const MISSING_SETUP = 'something the site lacks, said where it would be used, with who can add it';
const ONE_READING = 'one of the readings of a line that says something else when there is a value';
const ALERT = 'a failure, in an alert';
const IN_ITS_LABEL =
  'a check box or radio, pressed through the label around it, which is a finger’s height on touch';

export const ALLOWED = {
  /** `<file> <literal>`: colours that are data, not styles. */
  rawColours: {
    'boards/BoardSettingsPage.tsx #2f6fdb': SAMPLE_DATA,
    'boards/fixtures.ts #2f6fdb': SAMPLE_DATA,
    'boards/fixtures.ts #c4314b': SAMPLE_DATA,
    'builder/form.ts #6d5bd0': 'the accent a kit starts with, written into what the Builder makes',
    'session/GoogleMark.tsx #EA4335': GOOGLE_MARK,
    'session/GoogleMark.tsx #4285F4': GOOGLE_MARK,
    'session/GoogleMark.tsx #FBBC05': GOOGLE_MARK,
    'session/GoogleMark.tsx #34A853': GOOGLE_MARK,
    'plans/planImage.ts #ffffff': PRINTED,
    'plans/planImage.ts #1c2230': PRINTED,
    'plans/planImage.ts #566072': PRINTED,
    'plans/planImage.ts #d9dde5': PRINTED,
    'plans/planImage.ts #f2f4f8': PRINTED,
    'plans/planImage.ts #3f6fc4': PRINTED,
    'plans/planImage.ts #8a97ad': PRINTED,
    'plans/planImage.ts #0f7b6c': PRINTED,
    'plans/planImage.ts #7a4fb5': PRINTED,
    'plans/planImage.ts #b3261e': PRINTED,
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
    '.glass-card':
      'under 768 px only, in surfaces.css: the fallback tokens.css gives glass that cannot blur (ADR-114)',
    '.timeline-head': STICKY,
    '.timeline-corner': STICKY,
    '.timeline-label': STICKY,
    '.timeline-edge': STICKY,
    '.timeline-group .timeline-label': STICKY,
    '.capacity-table thead th': STICKY,
    '.capacity-table tbody th': STICKY,
    '.capacity-row.is-team th': STICKY,
    '.capacity-table tbody td:last-child': STICKY,
    '.capacity-row.is-team td:last-child': STICKY,
    '.program-board tbody th': STICKY,
    '.scenario-action-bar':
      'the change list’s actions stuck to the foot of a phone’s page: the cards scroll under it, so glass would show them through its buttons',
    '.create-dialog .create-form > .form-actions':
      "the create dialog's sticky foot (D3): the form scrolls under Create, so glass would show it through",
    '.timeline-fade':
      'the rows fading out at the foot of the timeline, into the colour of its sticky cells; no text',
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
  /** `<file> <message ID>`: a "none" that is no empty list, or says more than an empty list would. */
  bareEmpties: {
    'admin/AiSettingsPage.tsx ai.keyStorageNone': 'a failure, in an alert: no key can be kept',
    // `noX` sentences (T-222): matched since the guard reads them too.
    'admin/AiUsagePage.tsx admin.aiUsage.noPrice': FACT,
    'admin/imports/ImportWizard.tsx admin.imports.files.noFolder': MISSING_SETUP,
    'ai/SummaryPanel.tsx ai.summary.noCitations': ONE_READING,
    'boards/BoardPage.tsx boards.column.noStatus':
      'a warning on a column no card can enter, with where to fix it',
    'builder/MissingBuild.tsx builder.noBuild': ALERT,
    'dashboards/WidgetSettings.tsx dashboards.setting.noBoards': NO_CHOICE,
    'layouts/LayoutCanvas.tsx layouts.noSections':
      'a hint on how to place the fields still waiting: the list beside it is not empty',
    'people/TeamsPage.tsx admin.teams.noLead': FACT,
    'tickets/templates/TemplateForm.tsx tickets.templates.noTrackValues':
      "a field's value, read where its list of values would be: the template holds none (T-291)",
    'permissions/PermissionExplainerPage.tsx admin.explain.noGrant':
      'one answer of the permission explainer, beside the others it can give',
    'permissions/PermissionExplainerPage.tsx admin.explain.noLevel': ONE_READING,
    'plans/PlanCapacityPage.tsx plans.capacity.noPointsField': MISSING_SETUP,
    'plans/PlanCapacityPage.tsx plans.capacity.noTeams': MISSING_SETUP,
    'plans/PlanPage.tsx plans.notice.noSources': MISSING_SETUP,
    'plans/PlanListPage.tsx list.group.noValue': 'the heading of the group of rows with no value',
    'plans/PlanSettingsPage.tsx plans.settings.noLinkTypes': NO_CHOICE,
    'plans/ProgramBoardPage.tsx programBoard.noField': ONE_READING,
    'plans/ProgramBoardsPage.tsx programBoard.noField': ONE_READING,
    'plans/ProgramBoardsPage.tsx programBoards.noField': MISSING_SETUP,
    'plans/ScenarioCompare.tsx scenario.compare.noTeamField': MISSING_SETUP,
    'releases/CrossTrackReleasePage.tsx crossTrack.new.noMove':
      'what linking a release does to its dates, not a list',
    'releases/NewCrossTrackDialog.tsx crossTrack.new.noMove':
      'what linking a release does to its dates, not a list',
    'releases/ReleasePage.tsx crossTrack.new.noMove':
      'what linking a release does to its dates, not a list',
    'releases/ReleasePage.tsx release.noDate': FACT,
    'reports/ScopeReports.tsx reports.scope.noForecast': ONE_READING,
    'reports/ScopeReports.tsx reports.release.noForecast': ONE_READING,
    'reports/ScopeReports.tsx reports.outcome.noEstimate': FACT,
    'shell/CommandPalette.tsx palette.noResults':
      'a line in the command palette, which changes as the person types on',
    'sprints/SprintSettingsSection.tsx sprints.settings.noFields': NO_CHOICE,
    'tickets/tools/SubticketsPanel.tsx ticketTools.subtickets.noType': MISSING_SETUP,
    'tickets/view/InfoPanel.tsx ticketInfo.noComments': FACT,
    'tickets/view/InfoPanel.tsx ticketInfo.noResponse': FACT,
    'timeline/TimelineView.tsx timeline.noDate': 'a day not set, inside a sentence on the dates',
    'timeline/TimelineView.tsx timeline.panel.noRollup': ONE_READING,
    'trackgroups/ShareGroupDialog.tsx trackGroups.noRolesToGive': NO_CHOICE,
    'tracks/TrackNumbers.tsx summary.noPriority': 'the name of the row of tickets with no priority',
    'workflow/RuleEditor.tsx admin.workflow.transition.noGuards':
      'what a transition with no guards allows, said where its guards are added',
    'workflow/WorkflowImport.tsx admin.workflows.report.noProblems':
      'the verdict of an import report, under its heading',
    'ai/DataStatement.tsx ai.statement.none': 'one word inside a sentence on what is masked',
    'dashboards/WidgetEditor.tsx dashboards.column.empty':
      'the drop zone of a column being edited: it says where to drop, and has the shape of one',
    'layouts/LayoutCanvas.tsx layouts.hideWhenEmptyHint': SETTING_HINT,
    'layouts/LayoutEditorPage.tsx layouts.source.none':
      'one of three readings of the line on where a form gets its layout from',
    'layouts/LayoutEditorPage.tsx layouts.usedByNone': FACT,
    'layouts/LayoutPreview.tsx layouts.preview.hidesWhenEmpty': SETTING_HINT,
    'richtext/CollaborativeEditor.tsx richtext.collab.empty': 'what a blank document shows to read',
    'richtext/RichTextEditor.tsx richtext.mention.none': CARET_MENU,
    'richtext/RichTextEditor.tsx richtext.slash.none': CARET_MENU,
    'sprints/CompleteSprint.tsx sprints.completeDialog.empty':
      'one of four readings of the line that counts a sprint in its dialog',
    'tickets/view/InfoPanel.tsx ticketView.none': FACT,
    'tickets/view/TicketPage.tsx ticketView.none': FACT,
    'workflow/PublishPanel.tsx admin.workflow.publishPanel.empty':
      'one status of several, among those with a choice to make',
    'workflow/TransitionInspector.tsx admin.workflow.transition.fromNone':
      'a problem with a transition, shown with its rule',
  },
  /**
   * Selectors: what the finger-height guard takes for a target but no finger presses (T-294). Only
   * genuine non-targets belong here; a control a finger presses gets a finger's height instead.
   */
  shortTargets: {
    // Check boxes and radios: drawn at one size, 20 px and 24 or 28 px on touch (TR-24, AC-11,
    // AC-12), inside a label that a finger presses and that is a finger's height on touch.
    ':where(input:is([type="checkbox"], [type="radio"]))': IN_ITS_LABEL,
    ':where(.check-row input:is([type="checkbox"], [type="radio"]))': IN_ITS_LABEL,
    '.form-field-inline input:is([type="checkbox"], [type="radio"])': IN_ITS_LABEL,
    '.appearance-option input': IN_ITS_LABEL,
    '.notification-choice input': IN_ITS_LABEL,
    '.notification-event input': IN_ITS_LABEL,
    '.notification-events input': IN_ITS_LABEL,
    '.board-settings-check input[type="checkbox"]': IN_ITS_LABEL,
    '.sprint-select-all input': IN_ITS_LABEL,
    '.sprint-ticket-select input': IN_ITS_LABEL,
    '.checklist-item input[type="checkbox"]': IN_ITS_LABEL,
    '.reports-check input': IN_ITS_LABEL,
    '.tutorial-card-pick input': IN_ITS_LABEL,
  },
  /** `<file> <component>`: rendered in a `glass-card`, and draws one only where it is not nested. */
  glassInGlass: {
    'admin/AdminOverviewPage.tsx AdminPageLinks':
      'its file draws a glass card around the same links; the links themselves draw none',
    'tutorial/FirstRunOffer.tsx TutorialPicker': 'told it is `nested`, it draws wells',
  },
} satisfies Record<string, Record<string, string>>;

export const OFFENDERS = {
  /** Panels and wells on an opaque token; `--glass-surface-sunken` is the like-for-like glass. */
  opaqueSurfaces: {} as Ratchet,
  /** `h1` or `.page-title` outside PageHeader. */
  titles: {} as Ratchet,
  /** Route pages with no PageHeader; a purpose is ready in messages.en.ts (`purpose.*`, an intro). */
  pagesWithoutHeader: [] as string[],
  noPurpose: {} as Ratchet,
  /** `<button>` or `<table>` with no class and no rule through a parent. */
  bareControls: {} as Ratchet,
  /** `<fieldset>` classes that no stylesheet names. */
  fieldsetsWithoutRule: {} as Ratchet,
  /** "None" sentences outside an EmptyState; bodies are ready as `empty.*`. */
  bareEmpties: {} as Ratchet,
  /** Raw colours; there are none left to fix. */
  rawColours: {} as Ratchet,
  /**
   * Targets with a fixed height under a finger's and none on a touch screen (T-294): a min-height
   * of `var(--hit-target-touch)` under `(pointer: coarse)`, or a press area drawn by `::after`.
   */
  shortTargets: {} as Ratchet,
  /** Grips styled in a script on no element the touch checks know of (T-294): give them a class. */
  inlineGrips: {} as Ratchet,
};

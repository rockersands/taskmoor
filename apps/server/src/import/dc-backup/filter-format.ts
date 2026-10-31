/**
 * Saved filters, dashboards and filter subscriptions as a Data Center backup holds them (M1-094;
 * ADR-096), from general knowledge of the format, every rule marked **Verify** in the format
 * notes (02d). This is the format layer, merged into `format.ts`'s `ENTITIES`; it imports
 * nothing back, so the two files stay acyclic. The generator is `filters.ts`, the stage
 * `stage-filters.ts`, the checks `validate-filters.ts`.
 */
const id = { type: 'id' } as const;
const int = { type: 'int' } as const;
const optInt = { type: 'int', optional: true } as const;
const text = { type: 'text' } as const;
const optText = { type: 'text', optional: true } as const;
const longText = { type: 'text', optional: true, long: true } as const;
const user = { type: 'user' } as const;
const optUser = { type: 'user', optional: true } as const;
const entityType = { type: 'enum', values: ['SearchRequest', 'PortalPage'] } as const;

/** The elements of this part (merged into `format.ts`'s `ENTITIES`). */
export const FILTER_ENTITIES = {
  SharePermissions: {
    attrs: {
      id,
      entityId: int,
      entityType,
      sharetype: { type: 'enum', values: ['global', 'loggedin', 'group', 'project'] },
      // A group's name; a project's id; with a project, a role's id.
      param1: optText,
      param2: optText,
      // 1 to view; 3 to view and change (Verify).
      rights: optInt,
    },
  },
  FavouriteAssociations: {
    attrs: { id, username: user, entityType, entityId: int, sequence: optInt },
  },
  PortalPage: {
    attrs: {
      id,
      username: optUser,
      pagename: text,
      description: optText,
      sequence: optInt,
      favCount: optInt,
      layout: { type: 'enum', values: ['A', 'AA', 'AAA', 'AB', 'BA'] },
      ppversion: optInt,
    },
  },
  PortletConfiguration: {
    attrs: {
      id,
      portalpage: { type: 'ref', to: 'PortalPage' },
      columnNumber: int,
      positionSeq: int,
      gadgetXml: optText,
      color: optText,
    },
  },
  GadgetUserPreference: {
    attrs: {
      id,
      portletconfiguration: { type: 'ref', to: 'PortletConfiguration' },
      userprefkey: text,
      userprefvalue: longText,
    },
  },
  FilterSubscription: {
    attrs: {
      id,
      filterID: { type: 'ref', to: 'SearchRequest' },
      username: user,
      groupname: { type: 'group', optional: true },
      lastRun: { type: 'time', optional: true },
      emailOnEmpty: { type: 'enum', values: ['true', 'false'], optional: true },
    },
  },
  ClusteredJob: {
    attrs: {
      id,
      jobId: text,
      jobRunnerKey: text,
      schedType: { type: 'enum', values: ['C', 'I'] },
      intervalMillis: optInt,
      firstRun: optInt,
      cronExpression: optText,
      nextRun: optInt,
      parameters: longText,
    },
  },
} as const;

export const FILTER_ELEMENTS = Object.keys(FILTER_ENTITIES) as (keyof typeof FILTER_ENTITIES)[];

/** `ClusteredJob.jobId` of a subscription's schedule: the prefix, then its id (Verify). */
export const SUBSCRIPTION_JOB = 'JIRA-SUB-';
/** `ClusteredJob.jobRunnerKey` of subscriptions (Verify). */
export const SUBSCRIPTION_RUNNER = 'com.atlassian.jira.issue.subscription.FilterSubscriptionJob';
/** `SharePermissions.rights` that let the person change the shared thing too (Verify). */
export const EDIT_RIGHTS = 3;
/** A gadget's setting that names a filter or a project: `filter-<id>` or `project-<id>`. */
export const FILTER_PREFIX = 'filter-';
export const PROJECT_PREFIX = 'project-';

/** Gadgets by the module key their URI holds (Verify), with the settings they are written with. */
export const GADGETS = {
  filterResults:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:filter-results-gadget/gadgets/filter-results-gadget.xml',
  assignedToMe:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:assigned-to-me-gadget/gadgets/assigned-to-me-gadget.xml',
  watched:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:watched-gadget/gadgets/watched-gadget.xml',
  pie: 'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:pie-chart-gadget/gadgets/piechart-gadget.xml',
  createdVsResolved:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:created-vs-resolved-issues-chart-gadget/gadgets/createdvsresolved-gadget.xml',
  recentlyCreated:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:recently-created-chart-gadget/gadgets/recently-created-gadget.xml',
  averageAge:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:average-age-chart-gadget/gadgets/average-age-gadget.xml',
  resolutionTime:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:resolution-time-gadget/gadgets/resolution-time-gadget.xml',
  statistics: 'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:stats-gadget/gadgets/stats-gadget.xml',
  twoDimensional:
    'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:two-dimensional-stats-gadget/gadgets/two-dimensional-stats-gadget.xml',
  text: 'rest/gadgets/1.0/g/com.atlassian.jira.gadgets:text-gadget/gadgets/text-gadget.xml',
  sprintBurndown:
    'rest/gadgets/1.0/g/com.pyxis.greenhopper.jira:greenhopper-gadget-sprint-burndown/gadgets/greenhopper-sprint-burndown.xml',
  daysRemaining:
    'rest/gadgets/1.0/g/com.pyxis.greenhopper.jira:greenhopper-gadget-sprint-days-remaining/gadgets/greenhopper-sprint-days-remaining.xml',
  activity:
    'rest/gadgets/1.0/g/com.atlassian.streams.streams-jira-plugin:activitystream-gadget/gadgets/activitystream-gadget.xml',
  calendar: 'rest/gadgets/1.0/g/com.example.calendar:month-calendar/gadgets/calendar.xml',
} as const;
export type GadgetKind = keyof typeof GADGETS;

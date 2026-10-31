import { AGILE_AO_TABLES, AGILE_ENTITIES } from './agile-format';
import { WORKFLOW_ENTITIES } from './workflow-format';

/**
 * The shape of a Data Center backup ZIP as Taskmoor reads it (M1-087), from public format
 * descriptions only (ADR-003): `docs/specs/02d-dc-backup-format.md` cites the source of every
 * rule here and marks the ones still to verify against design partners' backups. The generator
 * writes this shape and the validator checks it; the backup reader (M1-088) parses it. This is
 * the format layer, so it uses the format's own names (Issue, Project, Action ...).
 */

export const ENTITIES_FILE = 'entities.xml';
export const ACTIVE_OBJECTS_FILE = 'activeobjects.xml';
export const ATTACHMENTS_DIR = 'data/attachments';
export const ENTITIES_ROOT = 'entity-engine-xml';
export const AO_ROOT = 'backup';
export const AO_NAMESPACE = 'http://www.atlassian.com/ao';
export const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

/** Issue numbers per attachment bucket folder. */
export const BUCKET_SIZE = 10_000;

/** `data/attachments/<original project key>/<bucket>/<issue key>/<attachment id>`. */
export function attachmentPath(
  projectKey: string,
  issueNumber: number,
  issueKey: string,
  attachmentId: number,
): string {
  const bucket = Math.ceil(issueNumber / BUCKET_SIZE) * BUCKET_SIZE;
  return `${ATTACHMENTS_DIR}/${projectKey}/${bucket}/${issueKey}/${attachmentId}`;
}

/** Splits an attachment path; null when it is not one. */
export function parseAttachmentPath(
  path: string,
): { projectKey: string; bucket: number; issueKey: string; id: number } | null {
  const m = /^data\/attachments\/([A-Z][A-Z0-9_]*)\/(\d+)\/([A-Z][A-Z0-9_]*-\d+)\/(\d+)$/.exec(
    path,
  );
  if (!m) return null;
  return {
    projectKey: m[1] as string,
    bucket: Number(m[2]),
    issueKey: m[3] as string,
    id: Number(m[4]),
  };
}

/** A moment as the entities file writes it: `YYYY-MM-DD HH:MM:SS.fff`, no zone (UTC here). */
export function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
}
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/** A text value goes into a child element (CDATA) when it has a line break or is longer. */
export const ATTRIBUTE_TEXT_MAX = 255;

// --- Entities ------------------------------------------------------------------------------

/**
 * One attribute: `id` (the row's integer id, unique per element), `int`, `number` (a decimal
 * number, as doubles are written), `bool` (1 or 0),
 * `time`, `text`, `enum`, `ref` (another element's id), `user` (a user key, which may name a
 * person with no row: a deleted user), `group` (a group name).
 */
export type Attr =
  | { type: 'id' }
  | { type: 'int' | 'number' | 'bool' | 'time' | 'user' | 'group'; optional?: true }
  | { type: 'text'; optional?: true; long?: true }
  | { type: 'enum'; values: readonly string[]; optional?: true }
  | { type: 'ref'; to: string; optional?: true };

export interface EntitySpec {
  attrs: Readonly<Record<string, Attr>>;
}

const id = { type: 'id' } as const;
const int = { type: 'int' } as const;
const optInt = { type: 'int', optional: true } as const;
const bool = { type: 'bool' } as const;
const time = { type: 'time' } as const;
const optTime = { type: 'time', optional: true } as const;
const text = { type: 'text' } as const;
const optText = { type: 'text', optional: true } as const;
const longText = { type: 'text', optional: true, long: true } as const;
const optUser = { type: 'user', optional: true } as const;
const optNumber = { type: 'number', optional: true } as const;
/** `true` or `false`, as the field configuration tables write their flags (Verify). */
const textFlag = { type: 'enum', values: ['true', 'false'], optional: true } as const;
const ref = (to: string) => ({ type: 'ref', to }) as const;
const optRef = (to: string) => ({ type: 'ref', to, optional: true }) as const;

/** Every element the generator writes, with its attributes. */
export const ENTITIES = {
  ConfigurationContext: {
    attrs: {
      id,
      projectcategory: optInt,
      project: optRef('Project'),
      key: text,
      fieldconfigscheme: ref('FieldConfigScheme'),
    },
  },
  CustomField: {
    attrs: {
      id,
      customfieldtypekey: text,
      customfieldsearcherkey: optText,
      cfname: text,
      description: longText,
    },
  },
  CustomFieldOption: {
    attrs: {
      id,
      customfield: ref('CustomField'),
      customfieldconfig: ref('FieldConfiguration'),
      parentoptionid: optRef('CustomFieldOption'),
      sequence: int,
      customvalue: text,
      disabled: { type: 'enum', values: ['Y', 'N'], optional: true },
    },
  },
  CustomFieldValue: {
    attrs: {
      id,
      issue: ref('Issue'),
      customfield: ref('CustomField'),
      parentkey: optText,
      stringvalue: optText,
      numbervalue: optNumber,
      textvalue: longText,
      datevalue: optTime,
    },
  },
  FieldConfigScheme: {
    attrs: { id, name: text, description: optText, fieldid: text },
  },
  FieldConfigSchemeIssueType: {
    attrs: {
      id,
      issuetype: optRef('IssueType'),
      fieldconfigscheme: ref('FieldConfigScheme'),
      fieldconfiguration: ref('FieldConfiguration'),
    },
  },
  FieldConfiguration: {
    attrs: { id, name: text, description: optText, fieldid: text },
  },
  FieldLayout: {
    attrs: {
      id,
      name: text,
      description: optText,
      type: { type: 'enum', values: ['default'], optional: true },
    },
  },
  FieldLayoutItem: {
    attrs: {
      id,
      fieldlayout: ref('FieldLayout'),
      fieldidentifier: text,
      description: longText,
      verticalposition: optInt,
      ishidden: textFlag,
      isrequired: textFlag,
      renderertype: optText,
    },
  },
  FieldLayoutScheme: { attrs: { id, name: text, description: optText } },
  FieldLayoutSchemeEntity: {
    attrs: {
      id,
      scheme: ref('FieldLayoutScheme'),
      issuetype: optRef('IssueType'),
      fieldlayout: ref('FieldLayout'),
    },
  },
  FieldScreen: { attrs: { id, name: text, description: optText } },
  FieldScreenLayoutItem: {
    attrs: { id, fieldidentifier: text, sequence: int, fieldscreentab: ref('FieldScreenTab') },
  },
  FieldScreenScheme: { attrs: { id, name: text, description: optText } },
  FieldScreenSchemeItem: {
    attrs: {
      id,
      operation: optInt,
      fieldscreen: ref('FieldScreen'),
      fieldscreenscheme: ref('FieldScreenScheme'),
    },
  },
  FieldScreenTab: {
    attrs: { id, name: text, description: optText, sequence: int, fieldscreen: ref('FieldScreen') },
  },
  GenericConfiguration: {
    attrs: { id, datatype: text, datakey: text, xmlvalue: longText },
  },
  IssueTypeScreenScheme: { attrs: { id, name: text, description: optText } },
  IssueTypeScreenSchemeEntity: {
    attrs: {
      id,
      issuetype: optRef('IssueType'),
      scheme: ref('IssueTypeScreenScheme'),
      fieldscreenscheme: ref('FieldScreenScheme'),
    },
  },
  NodeAssociation: {
    attrs: {
      sourceNodeId: int,
      sourceNodeEntity: text,
      sinkNodeId: int,
      sinkNodeEntity: text,
      associationType: text,
    },
  },
  GlobalPermissionEntry: {
    attrs: { id, permission: text, group_id: { type: 'group', optional: true } },
  },
  IssueSecurityScheme: {
    attrs: {
      id,
      name: text,
      description: optText,
      defaultlevel: optRef('SchemeIssueSecurityLevels'),
    },
  },
  Notification: {
    attrs: {
      id,
      scheme: ref('NotificationScheme'),
      eventTypeId: int,
      type: text,
      parameter: optText,
    },
  },
  NotificationScheme: { attrs: { id, name: text, description: optText } },
  PermissionScheme: { attrs: { id, name: text, description: optText } },
  SchemeIssueSecurities: {
    attrs: {
      id,
      scheme: ref('IssueSecurityScheme'),
      security: ref('SchemeIssueSecurityLevels'),
      type: text,
      parameter: optText,
    },
  },
  SchemeIssueSecurityLevels: {
    attrs: { id, name: text, description: optText, scheme: ref('IssueSecurityScheme') },
  },
  SchemePermissions: {
    attrs: {
      id,
      scheme: ref('PermissionScheme'),
      permission: optInt,
      permissionKey: text,
      type: text,
      parameter: optText,
    },
  },
  Action: {
    attrs: {
      id,
      issue: ref('Issue'),
      author: optUser,
      type: { type: 'enum', values: ['comment'] },
      level: { type: 'group', optional: true },
      rolelevel: optRef('ProjectRole'),
      body: { type: 'text', long: true },
      created: time,
      updateauthor: optUser,
      updated: time,
    },
  },
  ApplicationUser: { attrs: { id, userKey: text, lowerUserName: text } },
  ChangeGroup: { attrs: { id, issue: ref('Issue'), author: optUser, created: time } },
  ChangeItem: {
    attrs: {
      id,
      group: ref('ChangeGroup'),
      fieldtype: { type: 'enum', values: ['jira', 'custom'] },
      field: text,
      oldvalue: optText,
      oldstring: longText,
      newvalue: optText,
      newstring: longText,
    },
  },
  Directory: { attrs: { id, directoryName: text, active: bool, directoryPosition: int } },
  FileAttachment: {
    attrs: {
      id,
      issue: ref('Issue'),
      mimetype: text,
      filename: text,
      created: time,
      filesize: int,
      author: optUser,
      zip: bool,
      thumbnailable: bool,
    },
  },
  Group: {
    attrs: {
      id,
      groupName: text,
      lowerGroupName: text,
      active: bool,
      local: bool,
      createdDate: time,
      updatedDate: time,
      type: { type: 'enum', values: ['GROUP'] },
      directoryId: ref('Directory'),
    },
  },
  Issue: {
    attrs: {
      id,
      project: ref('Project'),
      number: int,
      type: ref('IssueType'),
      status: ref('Status'),
      priority: optRef('Priority'),
      resolution: optRef('Resolution'),
      reporter: optUser,
      assignee: optUser,
      creator: optUser,
      summary: text,
      description: longText,
      created: time,
      updated: time,
      resolutiondate: optTime,
      duedate: optTime,
      votes: int,
      watches: int,
      timeoriginalestimate: optInt,
      timeestimate: optInt,
      timespent: optInt,
      security: optRef('SchemeIssueSecurityLevels'),
    },
  },
  IssueLink: {
    attrs: {
      id,
      linktype: ref('IssueLinkType'),
      source: ref('Issue'),
      destination: ref('Issue'),
      sequence: optInt,
    },
  },
  IssueLinkType: {
    attrs: {
      id,
      linkname: text,
      inward: text,
      outward: text,
      style: { type: 'enum', values: ['jira_subtask'], optional: true },
    },
  },
  IssueType: {
    attrs: {
      id,
      sequence: int,
      name: text,
      style: { type: 'enum', values: ['jira_subtask'], optional: true },
      description: optText,
    },
  },
  Label: { attrs: { id, issue: ref('Issue'), fieldid: optRef('CustomField'), label: text } },
  MovedIssueKey: { attrs: { id, oldIssueKey: text, issueId: ref('Issue') } },
  Membership: {
    attrs: {
      id,
      parentId: ref('Group'),
      childId: ref('User'),
      membershipType: { type: 'enum', values: ['GROUP_USER'] },
      parentName: text,
      lowerParentName: text,
      childName: text,
      lowerChildName: text,
      directoryId: ref('Directory'),
    },
  },
  Priority: { attrs: { id, sequence: int, name: text, description: optText } },
  Project: {
    attrs: {
      id,
      name: text,
      key: text,
      originalkey: text,
      lead: optUser,
      description: longText,
      counter: int,
      projecttype: { type: 'enum', values: ['software', 'business'] },
    },
  },
  ProjectRole: { attrs: { id, name: text, description: optText } },
  ProjectRoleActor: {
    attrs: {
      id,
      pid: ref('Project'),
      projectroleid: ref('ProjectRole'),
      roletype: {
        type: 'enum',
        values: ['atlassian-user-role-actor', 'atlassian-group-role-actor'],
      },
      roletypeparameter: text,
    },
  },
  RemoteIssueLink: {
    attrs: {
      id,
      issueid: ref('Issue'),
      globalid: optText,
      title: text,
      summary: longText,
      url: { type: 'text', long: true },
      iconurl: optText,
      icontitle: optText,
      relationship: optText,
      applicationtype: optText,
      applicationname: optText,
    },
  },
  Resolution: { attrs: { id, sequence: int, name: text, description: optText } },
  SearchRequest: { attrs: { id, name: text, author: optUser, request: longText } },
  SequenceValueItem: { attrs: { seqName: text, seqId: int } },
  Status: {
    attrs: {
      id,
      sequence: int,
      name: text,
      description: optText,
      statuscategory: { type: 'enum', values: ['2', '3', '4'] },
    },
  },
  UserAssociation: {
    attrs: {
      sourceName: { type: 'user' },
      sinkNodeId: ref('Issue'),
      sinkNodeEntity: { type: 'enum', values: ['Issue'] },
      associationType: { type: 'enum', values: ['WatchIssue', 'VoteIssue'] },
      created: optTime,
    },
  },
  User: {
    attrs: {
      id,
      directoryId: ref('Directory'),
      userName: text,
      lowerUserName: text,
      active: bool,
      createdDate: time,
      updatedDate: time,
      firstName: optText,
      lowerFirstName: optText,
      lastName: optText,
      lowerLastName: optText,
      displayName: text,
      lowerDisplayName: text,
      emailAddress: optText,
      lowerEmailAddress: optText,
      credential: optText,
    },
  },
  Worklog: {
    attrs: {
      id,
      issue: ref('Issue'),
      author: optUser,
      body: longText,
      created: time,
      updateauthor: optUser,
      updated: time,
      startdate: time,
      timeworked: int,
      grouplevel: { type: 'group', optional: true },
      rolelevel: optRef('ProjectRole'),
    },
  },
  // Workflows, their schemes and custom events (M1-090).
  ...WORKFLOW_ENTITIES,
  // Versions and components (M1-093).
  ...AGILE_ENTITIES,
} as const satisfies Record<string, EntitySpec>;
export type EntityName = keyof typeof ENTITIES;

/**
 * The order the generator writes elements in: by name, then the id sequences last. The order
 * is not part of the format, so readers must not depend on it; writing comments and history
 * before the issues they belong to makes sure ours do not.
 */
export const ENTITY_ORDER: readonly EntityName[] = [
  ...(Object.keys(ENTITIES) as EntityName[]).filter((e) => e !== 'SequenceValueItem').sort(),
  'SequenceValueItem',
];

/** Where configuration tables name a custom field: `customfield_<CustomField id>`. */
export const customFieldKey = (id: number) => `customfield_${id}`;
export const CUSTOM_FIELD_KEY = /^customfield_(\d+)$/;

/** The plugin key that prefixes the built-in custom field types (Verify). */
export const SYSTEM_FIELD_TYPES = 'com.atlassian.jira.plugin.system.customfieldtypes:';

/** The built-in custom field types the generator writes, by their key after the prefix. */
export const CUSTOM_FIELD_TYPES = [
  'textfield',
  'textarea',
  'float',
  'datepicker',
  'datetime',
  'select',
  'multiselect',
  'radiobuttons',
  'multicheckboxes',
  'cascadingselect',
  'userpicker',
  'multiuserpicker',
  'grouppicker',
  'multigrouppicker',
  'labels',
  'url',
  'readonlyfield',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Custom field types whose values name people by user key, or groups by name (Verify). */
export const PERSON_FIELD_TYPES: ReadonlySet<string> = new Set(
  ['userpicker', 'multiuserpicker'].map((t) => `${SYSTEM_FIELD_TYPES}${t}`),
);
export const GROUP_FIELD_TYPES: ReadonlySet<string> = new Set(
  ['grouppicker', 'multigrouppicker'].map((t) => `${SYSTEM_FIELD_TYPES}${t}`),
);

/** The `parentkey` of a cascading select's child value (Verify). */
export const CASCADE_CHILD_KEY = '1';

/** `FieldScreenSchemeItem.operation`: absent for the default screen (Verify). */
export const SCREEN_OPERATIONS = { create: 0, edit: 1, view: 2 } as const;

/** `UserAssociation` types for watching and voting for an issue (Verify). */
export const WATCH_ISSUE = 'WatchIssue';
export const VOTE_ISSUE = 'VoteIssue';

/** The change item fields a move between projects writes (Verify). */
export const MOVE_FIELDS = { project: 'project', key: 'Key' } as const;

/** `NodeAssociation` rows that tie a project to one of its schemes (Verify). */
export const PROJECT_SCHEME = 'ProjectScheme';

/** Status categories by the number the Status element stores. */
export const STATUS_CATEGORIES = { new: '2', done: '3', indeterminate: '4' } as const;

// --- Active objects ------------------------------------------------------------------------

export type AoType = 'integer' | 'string' | 'boolean' | 'timestamp' | 'double';

export interface AoColumn {
  name: string;
  type: AoType;
  /** JDBC type number (java.sql.Types) and precision, as the table definition states them. */
  sqlType: number;
  precision?: number;
  primaryKey?: true;
  autoIncrement?: true;
}

const BIGINT = -5;
const INTEGER = 4;
const VARCHAR = 12;
const BOOLEAN = 16;
const CLOB = 2005;

/**
 * The tables the generator writes: the boards and sprints of the agile plugin, then its columns,
 * quick filters, sub-queries and rank (M1-093, `agile-format.ts`).
 */
export const AO_TABLES: Readonly<Record<string, readonly AoColumn[]>> = {
  AO_60DB71_RAPIDVIEW: [
    {
      name: 'ID',
      type: 'integer',
      sqlType: BIGINT,
      precision: 19,
      primaryKey: true,
      autoIncrement: true,
    },
    { name: 'NAME', type: 'string', sqlType: VARCHAR, precision: 255 },
    { name: 'OWNER_USER_NAME', type: 'string', sqlType: VARCHAR, precision: 255 },
    { name: 'SAVED_FILTER_ID', type: 'integer', sqlType: BIGINT, precision: 19 },
    { name: 'SPRINTS_ENABLED', type: 'boolean', sqlType: BOOLEAN, precision: 1 },
  ],
  AO_60DB71_SPRINT: [
    {
      name: 'ID',
      type: 'integer',
      sqlType: BIGINT,
      precision: 19,
      primaryKey: true,
      autoIncrement: true,
    },
    { name: 'NAME', type: 'string', sqlType: VARCHAR, precision: 255 },
    { name: 'RAPID_VIEW_ID', type: 'integer', sqlType: BIGINT, precision: 19 },
    { name: 'STARTED', type: 'boolean', sqlType: BOOLEAN, precision: 1 },
    { name: 'CLOSED', type: 'boolean', sqlType: BOOLEAN, precision: 1 },
    { name: 'START_DATE', type: 'integer', sqlType: BIGINT, precision: 19 },
    { name: 'END_DATE', type: 'integer', sqlType: BIGINT, precision: 19 },
    { name: 'COMPLETE_DATE', type: 'integer', sqlType: BIGINT, precision: 19 },
    { name: 'GOAL', type: 'string', sqlType: CLOB, precision: 2_147_483_647 },
    { name: 'SEQUENCE', type: 'integer', sqlType: INTEGER, precision: 10 },
  ],
  ...AGILE_AO_TABLES,
};

export const AO_VALUE_TYPES: readonly AoType[] = [
  'integer',
  'string',
  'boolean',
  'timestamp',
  'double',
];

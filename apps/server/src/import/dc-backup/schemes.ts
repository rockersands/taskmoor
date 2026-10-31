import { fieldWorldOf } from './fields';
import { customFieldKey } from './format';
import { Random } from './random';
import {
  FIRST_ID,
  type Group,
  type IssueFacts,
  type Person,
  type Project,
  type World,
} from './world';

/**
 * The synthetic instance's access, visibility and notification configuration (M1-092):
 * permission schemes (two of them identical, as instances often have), issue security schemes
 * with levels, notification schemes, global permissions, and which project uses which scheme.
 * Each issue's security level comes from its own seed stream; a sub-task has its parent's.
 * This is the format layer, in the format's own vocabulary (ADR-003); names are invented.
 */

/** Who a permission, a security level or a notification names, as the backup writes it. */
export interface Grantee {
  type:
    | 'group'
    | 'user'
    | 'projectrole'
    | 'reporter'
    | 'assignee'
    | 'lead'
    | 'userCF'
    | 'groupCF'
    | 'applicationRole';
  /** A group name (none: anyone), a user key, a role id or a field key. */
  parameter: string | null;
}

export interface PermissionSchemeDef {
  id: number;
  name: string;
  description: string;
  grants: { permission: string; grantee: Grantee }[];
}

export interface SecurityLevelDef {
  id: number;
  name: string;
  description: string;
  members: Grantee[];
}

export interface SecuritySchemeDef {
  id: number;
  name: string;
  description: string;
  defaultLevel: number | null;
  levels: SecurityLevelDef[];
}

export interface NotificationDef {
  event: number;
  type: string;
  parameter: string | null;
}

export interface NotificationSchemeDef {
  id: number;
  name: string;
  description: string;
  notifications: NotificationDef[];
}

export interface SchemeWorld {
  permissionSchemes: PermissionSchemeDef[];
  securitySchemes: SecuritySchemeDef[];
  notificationSchemes: NotificationSchemeDef[];
  /** Global permissions by key, each to a group (null: anyone). */
  globalPermissions: { permission: string; group: string | null }[];
  permissionSchemeOf: Map<number, number>;
  securitySchemeOf: Map<number, number>;
  notificationSchemeOf: Map<number, number>;
}

/** A project's role actors, as the backup writes them (`ProjectRoleActor`). */
export interface RoleActor {
  role: number;
  user: Person | null;
  group: string | null;
}

/** The role actors of a project: its lead as a manager, a group, up to two observers. */
export function roleActors(world: World, project: Project): RoleActor[] {
  const [managers, contributors, observers] = world.roles.map((r) => r.id) as [
    number,
    number,
    number,
  ];
  const r = Random.derive(world.options.seed, 'role-actors', project.index);
  const out: RoleActor[] = [{ role: managers, user: project.lead, group: null }];
  out.push({ role: contributors, user: null, group: r.pick(world.groups).name });
  const seen = new Set<string>([project.lead.key]);
  for (let n = r.int(0, 2); n > 0; n--) {
    const p = world.users[r.int(0, world.users.length - 1)] as Person;
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ role: observers, user: p, group: null });
  }
  return out;
}

const built = new WeakMap<World, SchemeWorld>();

export function schemeWorldOf(world: World): SchemeWorld {
  let out = built.get(world);
  if (!out) {
    out = buildSchemeWorld(world);
    built.set(world, out);
  }
  return out;
}

const g = (type: Grantee['type'], parameter: string | null = null): Grantee => ({
  type,
  parameter,
});

function buildSchemeWorld(world: World): SchemeWorld {
  const [managers, contributors, observers] = world.roles.map((r) => String(r.id)) as [
    string,
    string,
    string,
  ];
  const groups = world.groups as Group[];
  const everyone = (groups[0] as Group).name;
  const firstTeam = (groups[1] ?? groups[0]) as Group;
  const lastTeam = (groups[groups.length - 1] ?? groups[0]) as Group;
  const fields = fieldWorldOf(world).fields;
  const cf = (name: string) =>
    customFieldKey((fields.find((f) => f.name === name) as { id: number }).id);
  const someone = (world.users[0] as Person).key;
  const another = (world.users[2] ?? world.users[0]) as Person;

  const common = (editors: Grantee) => [
    { permission: 'CREATE_ISSUES', grantee: editors },
    { permission: 'EDIT_ISSUES', grantee: editors },
    { permission: 'TRANSITION_ISSUES', grantee: editors },
    { permission: 'ASSIGNABLE_USER', grantee: g('projectrole', contributors) },
    { permission: 'ASSIGN_ISSUES', grantee: g('projectrole', managers) },
    { permission: 'ADD_COMMENTS', grantee: g('applicationRole') },
    { permission: 'EDIT_OWN_COMMENTS', grantee: g('applicationRole') },
    { permission: 'WORK_ON_ISSUES', grantee: editors },
    { permission: 'ADMINISTER_PROJECTS', grantee: g('projectrole', managers) },
    { permission: 'SET_ISSUE_SECURITY', grantee: g('projectrole', managers) },
    { permission: 'MANAGE_WATCHERS', grantee: g('lead') },
    { permission: 'VIEW_VOTERS_AND_WATCHERS', grantee: g('applicationRole') },
    // A plugin's own permission: nothing to map it to.
    { permission: 'com.example.reviews:APPROVE', grantee: g('projectrole', managers) },
  ];
  const open: PermissionSchemeDef['grants'] = [
    { permission: 'BROWSE_PROJECTS', grantee: g('group', everyone) },
    // A group grant without a group: anyone, signed in or not.
    { permission: 'BROWSE_PROJECTS', grantee: g('group') },
    ...common(g('group', everyone)),
  ];
  const permissionSchemes: PermissionSchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Open permissions',
      description: 'Everyone sees everything',
      grants: open,
    },
    {
      id: FIRST_ID + 1,
      name: 'Open permissions (copy)',
      description: 'A copy someone made of the open one',
      grants: open.map((x) => ({ ...x })),
    },
    {
      id: FIRST_ID + 2,
      name: 'Team permissions',
      description: 'The team, the reporter and the reviewer',
      grants: [
        { permission: 'BROWSE_PROJECTS', grantee: g('projectrole', contributors) },
        { permission: 'BROWSE_PROJECTS', grantee: g('projectrole', managers) },
        { permission: 'BROWSE_PROJECTS', grantee: g('reporter') },
        { permission: 'BROWSE_PROJECTS', grantee: g('userCF', cf('Reviewer')) },
        ...common(g('projectrole', contributors)),
        { permission: 'EDIT_ISSUES', grantee: g('assignee') },
      ],
    },
    {
      id: FIRST_ID + 3,
      name: 'Restricted permissions',
      description: 'Observers, the lead and the owning group',
      grants: [
        { permission: 'BROWSE_PROJECTS', grantee: g('projectrole', observers) },
        { permission: 'BROWSE_PROJECTS', grantee: g('lead') },
        { permission: 'BROWSE_PROJECTS', grantee: g('assignee') },
        { permission: 'BROWSE_PROJECTS', grantee: g('groupCF', cf('Owning group')) },
        { permission: 'BROWSE_PROJECTS', grantee: g('user', someone) },
        ...common(g('projectrole', observers)),
      ],
    },
  ];

  let level = FIRST_ID;
  const securitySchemes: SecuritySchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Confidentiality',
      description: 'Who may see sensitive issues',
      defaultLevel: null,
      levels: [
        {
          id: level++,
          name: 'Staff only',
          description: 'The first team and the managers',
          members: [g('group', firstTeam.name), g('projectrole', managers)],
        },
        {
          id: level++,
          name: 'Reporter and assignee',
          description: 'The people on the issue and the lead',
          members: [g('reporter'), g('assignee'), g('lead')],
        },
        {
          id: level++,
          name: 'Reviewers',
          description: 'Its reviewers and owning group',
          members: [
            g('userCF', cf('Reviewer')),
            g('userCF', cf('Helpers')),
            g('groupCF', cf('Owning group')),
            g('user', another.key),
          ],
        },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Customer data',
      description: 'Issues holding customer data',
      defaultLevel: FIRST_ID + 3,
      levels: [
        {
          id: level++,
          name: 'Signed in',
          description: 'Anyone signed in',
          members: [g('applicationRole')],
        },
        {
          id: level++,
          name: 'Team',
          description: 'The contributors',
          members: [g('projectrole', contributors)],
        },
      ],
    },
  ];

  const notificationSchemes: NotificationSchemeDef[] = [
    {
      id: FIRST_ID,
      name: 'Team notifications',
      description: 'Most events to the people on the issue',
      notifications: [
        { event: 1, type: 'Current_Assignee', parameter: null },
        { event: 1, type: 'Current_Reporter', parameter: null },
        { event: 1, type: 'All_Watchers', parameter: null },
        { event: 2, type: 'All_Watchers', parameter: null },
        { event: 2, type: 'Current_Assignee', parameter: null },
        { event: 3, type: 'Current_Assignee', parameter: null },
        { event: 4, type: 'Current_Reporter', parameter: null },
        { event: 4, type: 'Group_Dropdown', parameter: firstTeam.name },
        { event: 6, type: 'All_Watchers', parameter: null },
        { event: 6, type: 'Project_Role', parameter: observers },
        { event: 10, type: 'Single_User', parameter: someone },
        { event: 13, type: 'Project_Lead', parameter: null },
        { event: 14, type: 'All_Watchers', parameter: null },
        { event: 1, type: 'Single_Email_Address', parameter: 'team@example.test' },
        { event: 10_001, type: 'Current_Assignee', parameter: null },
      ],
    },
    {
      id: FIRST_ID + 1,
      name: 'Quiet notifications',
      description: 'Only the essentials',
      notifications: [
        { event: 1, type: 'Current_Assignee', parameter: null },
        { event: 3, type: 'Current_Assignee', parameter: null },
        { event: 5, type: 'User_Custom_Field_Value', parameter: cf('Reviewer') },
        { event: 7, type: 'Group_Custom_Field_Value', parameter: cf('Owning group') },
        { event: 9, type: 'Component_Lead', parameter: null },
        { event: 5, type: 'Current_User', parameter: null },
      ],
    },
  ];

  const globalPermissions = [
    { permission: 'SYSTEM_ADMIN', group: lastTeam.name },
    { permission: 'ADMINISTER', group: firstTeam.name },
    { permission: 'USE', group: everyone },
    { permission: 'USER_PICKER', group: everyone },
    { permission: 'CREATE_SHARED_OBJECTS', group: everyone },
    { permission: 'MANAGE_GROUP_FILTER_SUBSCRIPTIONS', group: firstTeam.name },
    { permission: 'BULK_CHANGE', group: everyone },
    { permission: 'GADGET_ONE_CLICK', group: null },
  ];

  // Projects in turn: open, the open copy, team, restricted, and around again.
  const permissionSchemeOf = new Map<number, number>();
  const securitySchemeOf = new Map<number, number>();
  const notificationSchemeOf = new Map<number, number>();
  for (const p of world.projects) {
    permissionSchemeOf.set(p.id, FIRST_ID + (p.index % 4));
    if (p.index % 3 === 0) securitySchemeOf.set(p.id, FIRST_ID);
    else if (p.index % 3 === 2) securitySchemeOf.set(p.id, FIRST_ID + 1);
    notificationSchemeOf.set(p.id, FIRST_ID + (p.index % 2));
  }
  return {
    permissionSchemes,
    securitySchemes,
    notificationSchemes,
    globalPermissions,
    permissionSchemeOf,
    securitySchemeOf,
    notificationSchemeOf,
  };
}

/** The security level of the issue at `index` in `project`, from its own stream. */
function levelAt(world: World, index: number, project: Project): number | null {
  const scheme = schemeWorldOf(world).securitySchemes.find(
    (s) => s.id === schemeWorldOf(world).securitySchemeOf.get(project.id),
  );
  if (!scheme) return null;
  const r = Random.derive(world.options.seed, 'security', index);
  return r.chance(0.4) ? r.pick(scheme.levels).id : null;
}

/** An issue's security level id: its own, or its parent's for a sub-task; null for none. */
export function securityOf(world: World, issue: IssueFacts): number | null {
  if (issue.parent) return levelAt(world, issue.parent.id - FIRST_ID, issue.project);
  return levelAt(world, issue.index, issue.project);
}

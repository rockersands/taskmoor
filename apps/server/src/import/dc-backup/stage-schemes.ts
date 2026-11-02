import { CUSTOM_FIELD_KEY } from './format';

/**
 * The access part of the stage (M1-092; IMP-004, IMP-005; ADR-090): permission schemes with
 * their grants, issue security schemes with their levels and members, notification schemes,
 * global permissions, and the projects using each scheme. All small: kept, and resolved after
 * the file. Identical permission schemes are merged into the first of them (IMP-005 (1)), and
 * the merged ones name it. This is the format layer, in the backup's vocabulary; `../dc-schemes.ts`
 * maps the records to access policies, visibility policies and levels, notification policies
 * and global grants.
 */

/** Who a grant, a level or a notification names, with its references resolved. */
export interface StagedGrantee {
  type: string;
  parameter: string | null;
  /** Staged ids: a person's lower-case key, a group's lower-case name, a role's or field's id. */
  user: string | null;
  group: string | null;
  role: string | null;
  field: string | null;
}

export interface StagedPermissionScheme {
  id: string;
  name: string;
  description: string;
  grants: { permission: string; grantee: StagedGrantee }[];
  /** Project ids using it, the merged schemes' included. */
  tracks: string[];
  /** The scheme this one is identical to, which carries its projects. */
  mergedInto: { id: string; name: string } | null;
}

export interface StagedSecurityScheme {
  id: string;
  name: string;
  description: string;
  tracks: string[];
}

export interface StagedSecurityLevel {
  id: string;
  scheme: string;
  name: string;
  description: string;
  position: number;
  isDefault: boolean;
  members: StagedGrantee[];
}

export interface StagedNotificationScheme {
  id: string;
  name: string;
  description: string;
  /** A custom event's name comes from its `EventType` row (M1-090). */
  notifications: { event: number | null; eventName?: string; grantee: StagedGrantee }[];
  tracks: string[];
}

export interface StagedGlobalPermission {
  id: string;
  permission: string;
  /** The group's staged id; null for anyone. */
  group: string | null;
  groupName: string | null;
  /**
   * What `SYSTEM_ADMIN` becomes, from the import's settings (not staged: the source adds it to
   * each record it reads, so changing the setting needs no new stage).
   */
  systemAdmins?: 'site_admin' | 'configuration_admin';
}

export const SCHEME_ELEMENTS = [
  'PermissionScheme',
  'SchemePermissions',
  'IssueSecurityScheme',
  'SchemeIssueSecurityLevels',
  'SchemeIssueSecurities',
  'NotificationScheme',
  'Notification',
  'GlobalPermissionEntry',
] as const;

/** Grantee types whose parameter is a user key. */
const PERSON_TYPES = new Set(['user', 'Single_User']);

interface Named {
  id: string;
  name: string;
  description: string;
}
interface RawGrantee {
  type: string;
  parameter: string | null;
}

const int = (v: string | undefined): number | null =>
  v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
const byId = <T extends { id: string }>(rows: Iterable<T>) =>
  [...rows].sort(
    (a, b) => Number(a.id) - Number(b.id) || String(a.id ?? '').localeCompare(String(b.id ?? '')),
  );

export class SchemeCollector {
  private readonly permissionSchemes = new Map<string, Named>();
  private readonly permissions: { scheme: string; key: string; grantee: RawGrantee }[] = [];
  private readonly securitySchemes = new Map<string, Named & { defaultLevel: string | null }>();
  private readonly levels: (Named & { scheme: string })[] = [];
  private readonly securities: { level: string; grantee: RawGrantee }[] = [];
  private readonly notificationSchemes = new Map<string, Named>();
  private readonly notifications: { scheme: string; event: number | null; grantee: RawGrantee }[] =
    [];
  private readonly globals: { id: string; permission: string; group: string | null }[] = [];
  /** Raw user keys named by grants, levels and notifications. */
  readonly personRefs: string[] = [];

  row(name: string, v: Record<string, string>): void {
    const id = v.id ?? '';
    const named = (): Named => ({ id, name: v.name ?? '', description: v.description ?? '' });
    const grantee = (): RawGrantee => {
      const g = { type: v.type ?? '', parameter: v.parameter ? v.parameter : null };
      if (g.parameter !== null && PERSON_TYPES.has(g.type)) this.personRefs.push(g.parameter);
      return g;
    };
    switch (name) {
      case 'PermissionScheme':
        this.permissionSchemes.set(id, named());
        return;
      case 'SchemePermissions':
        this.permissions.push({
          scheme: v.scheme ?? '',
          key: v.permissionKey ?? v.permission ?? '',
          grantee: grantee(),
        });
        return;
      case 'IssueSecurityScheme':
        this.securitySchemes.set(id, { ...named(), defaultLevel: v.defaultlevel ?? null });
        return;
      case 'SchemeIssueSecurityLevels':
        this.levels.push({ ...named(), scheme: v.scheme ?? '' });
        return;
      case 'SchemeIssueSecurities':
        this.securities.push({ level: v.security ?? '', grantee: grantee() });
        return;
      case 'NotificationScheme':
        this.notificationSchemes.set(id, named());
        return;
      case 'Notification':
        this.notifications.push({
          scheme: v.scheme ?? '',
          event: int(v.eventTypeId),
          grantee: grantee(),
        });
        return;
      case 'GlobalPermissionEntry':
        this.globals.push({ id, permission: v.permission ?? '', group: v.group_id ?? null });
        return;
    }
  }

  resolve(
    projects: ReadonlySet<string>,
    associations: ReadonlyMap<string, Map<string, string[]>>,
    refs: {
      person: (raw: string) => string;
      group: (raw: string) => string | null;
      role: (id: string) => boolean;
    },
  ) {
    const resolveGrantee = (g: RawGrantee): StagedGrantee => {
      const p = g.parameter;
      const field = p === null ? null : (CUSTOM_FIELD_KEY.exec(p)?.[1] ?? null);
      return {
        type: g.type,
        parameter: p,
        user: p !== null && PERSON_TYPES.has(g.type) ? refs.person(p) : null,
        group:
          p !== null && (g.type === 'group' || g.type === 'Group_Dropdown') ? refs.group(p) : null,
        role:
          p !== null && (g.type === 'projectrole' || g.type === 'Project_Role') && refs.role(p)
            ? p
            : null,
        field,
      };
    };
    const tracksOf = (element: string, id: string) =>
      (associations.get(element)?.get(id) ?? [])
        .filter((p) => projects.has(p))
        .sort((a, b) => Number(a) - Number(b));

    // Permission schemes, identical ones merged into the first (by id).
    const fingerprint = (id: string) =>
      JSON.stringify(
        this.permissions
          .filter((x) => x.scheme === id)
          .map((x) => [x.key, x.grantee.type, (x.grantee.parameter ?? '').toLowerCase()])
          .sort(),
      );
    const first = new Map<string, Named>();
    const permission = byId(this.permissionSchemes.values()).map((s) => {
      const print = fingerprint(s.id);
      const into = first.get(print) ?? null;
      if (!into) first.set(print, s);
      return { s, into };
    });
    const access = permission.map(({ s, into }) => {
      const merged = permission.filter((x) => x.into?.id === s.id).map((x) => x.s.id);
      const data: StagedPermissionScheme = {
        id: s.id,
        name: s.name,
        description: s.description,
        grants: this.permissions
          .filter((x) => x.scheme === s.id)
          .map((x) => ({ permission: x.key, grantee: resolveGrantee(x.grantee) })),
        tracks: [s.id, ...merged]
          .flatMap((id) => tracksOf('PermissionScheme', id))
          .sort((a, b) => Number(a) - Number(b)),
        mergedInto: into ? { id: into.id, name: into.name } : null,
      };
      if (into) data.tracks = [];
      return { id: s.id, label: s.name, data };
    });

    const visibility = byId(this.securitySchemes.values()).map((s) => {
      const data: StagedSecurityScheme = {
        id: s.id,
        name: s.name,
        description: s.description,
        tracks: tracksOf('IssueSecurityScheme', s.id),
      };
      return { id: s.id, label: s.name, data };
    });
    const levels = byId(this.levels).map((l) => {
      const scheme = this.securitySchemes.get(l.scheme);
      const position = byId(this.levels.filter((x) => x.scheme === l.scheme)).findIndex(
        (x) => x.id === l.id,
      );
      const data: StagedSecurityLevel = {
        id: l.id,
        scheme: l.scheme,
        name: l.name,
        description: l.description,
        position,
        isDefault: scheme?.defaultLevel === l.id,
        members: this.securities
          .filter((x) => x.level === l.id)
          .map((x) => resolveGrantee(x.grantee)),
      };
      return { id: l.id, label: `${scheme?.name ?? l.scheme}: ${l.name}`, data };
    });

    const notification = byId(this.notificationSchemes.values()).map((s) => {
      const data: StagedNotificationScheme = {
        id: s.id,
        name: s.name,
        description: s.description,
        notifications: this.notifications
          .filter((x) => x.scheme === s.id)
          .map((x) => ({ event: x.event, grantee: resolveGrantee(x.grantee) })),
        tracks: tracksOf('NotificationScheme', s.id),
      };
      return { id: s.id, label: s.name, data };
    });

    const global = byId(this.globals).map((x) => {
      const data: StagedGlobalPermission = {
        id: x.id,
        permission: x.permission,
        group: x.group === null ? null : refs.group(x.group),
        groupName: x.group,
      };
      return { id: x.id, label: `${x.permission}: ${x.group ?? 'anyone'}`, data };
    });

    return {
      access_policy: access,
      visibility_policy: visibility,
      visibility_level: levels,
      notification_policy: notification,
      global_grant: global,
    };
  }
}

import type { Database, GranteeKind } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { isGlobalPermission, isTrackPermission } from '../authz/permissions';
import { customKey } from '../fields/form-model';
import { enforceLimit } from '../guardrails/model';
import { type NotificationRuleInput, replaceNotificationRules } from '../notifications/rules';
import {
  existingTarget,
  type LoadContext,
  type Loader,
  lower,
  PENDING,
  PlanFailure,
  required,
} from './load';
import type {
  AccessPolicyCommand,
  GlobalGrantCommand,
  GrantTo,
  NotificationPolicyCommand,
  Ref,
  VisibilityLevelCommand,
  VisibilityPolicyCommand,
} from './model';

/**
 * Loaders for access, visibility and notification configuration (M1-092; IMP-004, IMP-005;
 * ADR-090): access policies with their grants, visibility policies, their levels with members,
 * notification policies with their rules, and global grants. A policy links to the target's of
 * the same name, which keeps its own grants, levels or rules as linked objects do (ADR-048), or
 * is created; either way the command's tracks then use it. A grantee whose person, group, role
 * or field the import did not bring is dropped with a warning, never widened.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A grantee's columns with references resolved; null when one did not map. */
interface GranteeRow {
  grantee: GranteeKind;
  role_id: number | null;
  group_id: number | null;
  user_id: number | null;
  field_key: string | null;
}

function granteeRow(ctx: LoadContext, to: GrantTo, where: string): GranteeRow | null | 'pending' {
  const resolve = (r: Ref | null) => (r === null ? null : ctx.refs.get(r));
  const role = resolve(to.role);
  const group = resolve(to.group);
  const user = resolve(to.user);
  const field = resolve(to.field);
  const wanted = [to.role, to.group, to.user, to.field];
  const got = [role, group, user, field];
  if (got.some((id, k) => wanted[k] !== null && id === null)) {
    ctx.warn({ code: 'grantee_not_imported', detail: `${where}:${to.grantee}` });
    return null;
  }
  if (got.includes(PENDING)) return 'pending';
  return {
    grantee: to.grantee,
    role_id: role,
    group_id: group,
    user_id: user,
    field_key: field === null ? null : customKey(field),
  };
}

const granteeKey = (r: GranteeRow) =>
  [r.grantee, r.role_id ?? 0, r.group_id ?? 0, r.user_id ?? 0, r.field_key ?? ''].join(':');

async function byName(
  ctx: LoadContext,
  table: 'access_policy' | 'visibility_policy' | 'notification_policy',
  name: string,
): Promise<number | null> {
  let q = ctx.trx
    .selectFrom(table)
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where(sql<string>`lower(name)`, '=', lower(name));
  q =
    table === 'access_policy'
      ? q.where('owner_track_id' as never, 'is', null)
      : q.where('track_id' as never, 'is', null);
  return (await q.executeTakeFirst())?.id ?? null;
}

function trackIds(ctx: LoadContext, refs: readonly Ref[]): number[] {
  return refs.flatMap((t) => {
    const id = ctx.refs.get(t);
    if (id === null) ctx.warn({ code: 'missing_reference', detail: 'tracks' });
    return id === null || id === PENDING ? [] : [id];
  });
}

async function planNamed(
  ctx: LoadContext,
  table: 'access_policy' | 'visibility_policy' | 'notification_policy',
  name: string,
  existing: number | null,
  data: unknown,
) {
  const fingerprint = { name: lower(name) };
  if (existing !== null) {
    await existingTarget(ctx, table, existing);
    return { action: 'update' as const, targetId: existing, fingerprint, data };
  }
  const found = await byName(ctx, table, name);
  if (found !== null) return { action: 'link' as const, targetId: found, fingerprint, data };
  return { action: 'create' as const, targetId: null, fingerprint, data };
}

const readNamed =
  (table: 'access_policy' | 'visibility_policy' | 'notification_policy') =>
  async (db: Db, ws: number, ids: readonly number[]) => {
    const rows = await db
      .selectFrom(table)
      .select(['id', 'name'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { name: lower(r.name) }]));
  };

const preloadGrantees = (tos: readonly GrantTo[]) =>
  tos.flatMap((t) => [t.role, t.group, t.user, t.field].filter((r): r is Ref => r !== null));

interface AccessData {
  grants: (GranteeRow & { permission: string })[];
  tracks: number[];
}

export const accessPolicies: Loader<AccessPolicyCommand> = {
  table: { name: 'access_policy', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(
      cmds.flatMap((c) => [...c.tracks, ...preloadGrantees(c.grants.map((g) => g.to))]),
    );
  },
  async plan(ctx, cmd, existing) {
    const grants = new Map<string, GranteeRow & { permission: string }>();
    let pending = false;
    for (const g of cmd.grants) {
      if (!isTrackPermission(g.permission))
        throw new PlanFailure(`unknown_permission:${g.permission}`);
      const row = granteeRow(ctx, g.to, g.permission);
      if (row === null) continue;
      if (row === 'pending') {
        pending = true;
        continue;
      }
      grants.set(`${g.permission}|${granteeKey(row)}`, { ...row, permission: g.permission });
      // Whoever runs a track may appoint others there, removable like any grant (ADR-118).
      if (g.permission === 'administer_track') {
        grants.set(`appoint_track_admins|${granteeKey(row)}`, {
          ...row,
          permission: 'appoint_track_admins',
        });
      }
    }
    if (pending && !ctx.dryRun) throw new PlanFailure('missing_reference:grants');
    const data: AccessData = { grants: [...grants.values()], tracks: trackIds(ctx, cmd.tracks) };
    return planNamed(ctx, 'access_policy', cmd.name, existing, data);
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as AccessData;
    const ws = ctx.workspaceId;
    let id = plan.targetId as number;
    if (plan.action === 'create') {
      id = (
        await ctx.trx
          .insertInto('access_policy')
          .values({ workspace_id: ws, name: cmd.name, description: cmd.description })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } else if (plan.action === 'update') {
      await ctx.trx
        .updateTable('access_policy')
        .set({ name: cmd.name, description: cmd.description })
        .where('id', '=', id)
        .execute();
      await ctx.trx.deleteFrom('access_grant').where('policy_id', '=', id).execute();
    }
    if (plan.action !== 'link' && d.grants.length > 0) {
      // The same guardrail as grants added one at a time (M1-020).
      const per = new Map<string, number>();
      for (const g of d.grants) per.set(g.permission, (per.get(g.permission) ?? 0) + 1);
      const most = Math.max(...per.values());
      await enforceLimit(ctx.trx, ws, 'grants_per_permission', most);
      await ctx.trx
        .insertInto('access_grant')
        .values(d.grants.map((g) => ({ workspace_id: ws, policy_id: id, ...g })))
        .execute();
    }
    if (d.tracks.length > 0) {
      await ctx.trx
        .updateTable('track')
        .set({ access_policy_id: id, updated_at: new Date() })
        .where('id', 'in', d.tracks)
        .execute();
    }
    return id;
  },
  read: readNamed('access_policy'),
};

export const visibilityPolicies: Loader<VisibilityPolicyCommand> = {
  table: { name: 'visibility_policy', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(cmds.flatMap((c) => c.tracks));
  },
  async plan(ctx, cmd, existing) {
    return planNamed(ctx, 'visibility_policy', cmd.name, existing, {
      tracks: trackIds(ctx, cmd.tracks),
    });
  },
  async apply(ctx, cmd, plan) {
    const { tracks } = plan.data as { tracks: number[] };
    let id = plan.targetId as number;
    if (plan.action === 'create') {
      id = (
        await ctx.trx
          .insertInto('visibility_policy')
          .values({
            workspace_id: ctx.workspaceId,
            track_id: null,
            name: cmd.name,
            description: cmd.description,
            default_level_id: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } else if (plan.action === 'update') {
      await ctx.trx
        .updateTable('visibility_policy')
        .set({ name: cmd.name, description: cmd.description, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
    }
    if (tracks.length > 0) {
      await ctx.trx
        .updateTable('track')
        .set({ visibility_policy_id: id, updated_at: new Date() })
        .where('id', 'in', tracks)
        .execute();
    }
    return id;
  },
  read: readNamed('visibility_policy'),
};

interface LevelData {
  policy: number;
  members: GranteeRow[];
}

export const visibilityLevels: Loader<VisibilityLevelCommand> = {
  table: { name: 'visibility_level', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(cmds.flatMap((c) => [c.policy, ...preloadGrantees(c.members)]));
  },
  async plan(ctx, cmd, existing) {
    const policy = required(ctx, cmd.policy, 'policy');
    const members = new Map<string, GranteeRow>();
    let pending = false;
    for (const m of cmd.members) {
      const row = granteeRow(ctx, m, 'member');
      if (row === null) continue;
      if (row === 'pending') {
        pending = true;
        continue;
      }
      members.set(granteeKey(row), row);
    }
    if (pending && !ctx.dryRun) throw new PlanFailure('missing_reference:members');
    const data: LevelData = { policy, members: [...members.values()] };
    const fingerprint = { policy: policy === PENDING ? null : policy, name: lower(cmd.name) };
    if (existing !== null) {
      await existingTarget(ctx, 'visibility_level', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    if (policy !== PENDING) {
      const found = await ctx.trx
        .selectFrom('visibility_level')
        .select('id')
        .where('policy_id', '=', policy)
        .where(sql<string>`lower(name)`, '=', lower(cmd.name))
        .executeTakeFirst();
      if (found) return { action: 'link', targetId: found.id, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as LevelData;
    const ws = ctx.workspaceId;
    if (plan.action === 'link') return plan.targetId as number;
    let id = plan.targetId as number;
    if (plan.action === 'create') {
      id = (
        await ctx.trx
          .insertInto('visibility_level')
          .values({
            workspace_id: ws,
            policy_id: d.policy,
            name: cmd.name,
            description: cmd.description,
            position: cmd.position,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } else {
      await ctx.trx
        .updateTable('visibility_level')
        .set({ name: cmd.name, description: cmd.description, position: cmd.position })
        .where('id', '=', id)
        .execute();
      await ctx.trx.deleteFrom('visibility_member').where('level_id', '=', id).execute();
    }
    if (d.members.length > 0) {
      await ctx.trx
        .insertInto('visibility_member')
        .values(d.members.map((m) => ({ workspace_id: ws, level_id: id, ...m })))
        .execute();
    }
    if (cmd.isDefault) {
      await ctx.trx
        .updateTable('visibility_policy')
        .set({ default_level_id: id })
        .where('id', '=', d.policy)
        .execute();
    }
    return id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('visibility_level')
      .select(['id', 'policy_id', 'name'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { policy: r.policy_id, name: lower(r.name) }]));
  },
};

interface NotificationData {
  rules: NotificationRuleInput[];
  tracks: number[];
}

export const notificationPolicies: Loader<NotificationPolicyCommand> = {
  table: { name: 'notification_policy', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(
      cmds.flatMap((c) => [
        ...c.tracks,
        ...c.rules.flatMap((r) =>
          [r.user, r.group, r.role, r.field].filter((x): x is Ref => x !== null),
        ),
      ]),
    );
  },
  async plan(ctx, cmd, existing) {
    const rules: NotificationData['rules'] = [];
    let pending = false;
    for (const r of cmd.rules) {
      const ids = [r.user, r.group, r.role, r.field].map((x) =>
        x === null ? null : ctx.refs.get(x),
      );
      if (ids.some((id, k) => id === null && [r.user, r.group, r.role, r.field][k] !== null)) {
        ctx.warn({ code: 'recipient_not_imported', detail: `${r.event}:${r.recipient}` });
        continue;
      }
      if (ids.includes(PENDING)) {
        pending = true;
        continue;
      }
      const [user, group, role, field] = ids;
      rules.push({
        event: r.event,
        recipient: r.recipient,
        ...(user ? { userId: user } : {}),
        ...(group ? { groupId: group } : {}),
        ...(role ? { roleId: role } : {}),
        ...(field ? { fieldKey: customKey(field) } : {}),
      });
    }
    if (pending && !ctx.dryRun) throw new PlanFailure('missing_reference:rules');
    const data: NotificationData = { rules, tracks: trackIds(ctx, cmd.tracks) };
    return planNamed(ctx, 'notification_policy', cmd.name, existing, data);
  },
  async apply(ctx, cmd, plan) {
    const d = plan.data as NotificationData;
    let id = plan.targetId as number;
    if (plan.action === 'create') {
      id = (
        await ctx.trx
          .insertInto('notification_policy')
          .values({
            workspace_id: ctx.workspaceId,
            track_id: null,
            name: cmd.name,
            description: cmd.description,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    } else if (plan.action === 'update') {
      await ctx.trx
        .updateTable('notification_policy')
        .set({ name: cmd.name, description: cmd.description, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
    }
    if (plan.action !== 'link') {
      await replaceNotificationRules(ctx.trx, ctx.workspaceId, id, d.rules);
    }
    if (d.tracks.length > 0) {
      await ctx.trx
        .updateTable('track')
        .set({ notification_policy_id: id, updated_at: new Date() })
        .where('id', 'in', d.tracks)
        .execute();
    }
    return id;
  },
  read: readNamed('notification_policy'),
};

/**
 * A grant imported before, whose permission the import now gives otherwise (system
 * administrators as configuration administrators, ADR-090): the grant changes in place, or goes
 * when the group already holds the new permission, so a re-import never leaves the wider one.
 */
async function regrant(
  ctx: LoadContext,
  id: number,
  permission: string,
  group: number | null,
): Promise<number> {
  const row = await ctx.trx
    .selectFrom('global_grant')
    .select('permission')
    .where('id', '=', id)
    .where('workspace_id', '=', ctx.workspaceId)
    .executeTakeFirst();
  if (!row || row.permission === permission) return id;
  const same = await ctx.trx
    .selectFrom('global_grant')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('permission', '=', permission)
    .where('grantee', '=', group === null ? 'any_user' : 'group')
    .where(sql<number>`coalesce(group_id, 0)`, '=', group ?? 0)
    .executeTakeFirst();
  if (same) {
    await ctx.trx.deleteFrom('global_grant').where('id', '=', id).execute();
    return same.id;
  }
  await ctx.trx
    .updateTable('global_grant')
    .set({ permission: permission })
    .where('id', '=', id)
    .execute();
  return id;
}

export const globalGrants: Loader<GlobalGrantCommand> = {
  table: { name: 'global_grant', id: 'id' },
  async prepare(ctx, cmds) {
    await ctx.refs.preload(cmds.flatMap((c) => (c.group ? [c.group] : [])));
  },
  async plan(ctx, cmd, existing) {
    if (!isGlobalPermission(cmd.permission)) throw new PlanFailure('unknown_permission');
    const group = cmd.group === null ? null : required(ctx, cmd.group, 'group');
    const fingerprint = { permission: cmd.permission, group: group === PENDING ? null : group };
    const data = { group };
    if (existing !== null) {
      await existingTarget(ctx, 'global_grant', existing);
      return { action: 'update', targetId: existing, fingerprint, data };
    }
    if (group !== PENDING) {
      const found = await ctx.trx
        .selectFrom('global_grant')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('permission', '=', cmd.permission)
        .where('grantee', '=', group === null ? 'any_user' : 'group')
        .where(sql<number>`coalesce(group_id, 0)`, '=', group ?? 0)
        .executeTakeFirst();
      if (found) return { action: 'link', targetId: found.id, fingerprint, data };
    }
    return { action: 'create', targetId: null, fingerprint, data };
  },
  async apply(ctx, cmd, plan) {
    const { group } = plan.data as { group: number | null };
    if (plan.action === 'update')
      return regrant(ctx, plan.targetId as number, cmd.permission, group);
    if (plan.action !== 'create') return plan.targetId as number;
    const row = await ctx.trx
      .insertInto('global_grant')
      .values({
        workspace_id: ctx.workspaceId,
        permission: cmd.permission,
        grantee: group === null ? 'any_user' : 'group',
        group_id: group,
        user_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async read(db, ws, ids) {
    const rows = await db
      .selectFrom('global_grant')
      .select(['id', 'permission', 'group_id'])
      .where('workspace_id', '=', ws)
      .where('id', 'in', [...ids])
      .execute();
    return new Map(rows.map((r) => [r.id, { permission: r.permission, group: r.group_id }]));
  },
};

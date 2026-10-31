import type { Database, NotificationRecipient } from '@taskmoor/db';
import type { Transaction } from 'kysely';

/**
 * The rules of a notification policy (M1-056; NTF-001): which recipients hear of each event.
 * The routes (`routes/notifications.ts`) and the importer (`import/load-access.ts`, M1-092)
 * both replace a policy's rules through here.
 */
export interface NotificationRuleInput {
  event: string;
  recipient: NotificationRecipient;
  userId?: number | undefined;
  groupId?: number | undefined;
  roleId?: number | undefined;
  fieldKey?: string | undefined;
}

/** A rule's identity: the same event, recipient and reference is one rule. */
export const ruleKey = (r: NotificationRuleInput) =>
  [r.event, r.recipient, r.userId ?? 0, r.groupId ?? 0, r.roleId ?? 0, r.fieldKey ?? ''].join(':');

/** Replaces a policy's rules, each once. */
export async function replaceNotificationRules(
  trx: Transaction<Database>,
  ws: number,
  policyId: number,
  rules: readonly NotificationRuleInput[],
): Promise<void> {
  await trx.deleteFrom('notification_rule').where('policy_id', '=', policyId).execute();
  const unique = new Map(rules.map((r) => [ruleKey(r), r]));
  if (unique.size === 0) return;
  await trx
    .insertInto('notification_rule')
    .values(
      [...unique.values()].map((r) => ({
        workspace_id: ws,
        policy_id: policyId,
        event: r.event,
        recipient: r.recipient,
        user_id: r.userId ?? null,
        group_id: r.groupId ?? null,
        role_id: r.roleId ?? null,
        field_key: r.fieldKey ?? null,
      })),
    )
    .execute();
}

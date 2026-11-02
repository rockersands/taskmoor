import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import {
  ALERT_RULE_LIMITS,
  ALERT_RULES,
  type AlertRule,
  alertRules,
  alertRulesInput,
  DEFAULT_ALERT_RULES,
  forgetAlertRules,
} from '../security/alerts';

/** Alerts shown with the rules: the latest ones. */
const RECENT = 20;

/**
 * The security alert rules (ASVS 11.1.7, 11.1.8; ADR-109), on the Security page of site
 * administrators:
 *
 * - `GET /api/v1/security/alerts`: each rule's switch, threshold and window, the defaults, the
 *   limits, and the latest alerts raised;
 * - `PUT /api/v1/security/alerts` `{rules: {<rule>: {enabled, threshold, windowMinutes}}}`:
 *   sets the rules named, each whole; the others keep theirs. A changed window starts counting
 *   afresh.
 */
export function registerSecurityAlertRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const view = async (ws: number) => {
    const recent = await db
      .selectFrom('security_alert')
      .select(['id', 'rule', 'count', 'threshold', 'window_minutes', 'details', 'raised_at'])
      .where('workspace_id', '=', ws)
      .orderBy('raised_at', 'desc')
      .orderBy('id', 'desc')
      .limit(RECENT)
      .execute();
    return {
      rules: await alertRules(db, ws),
      defaults: DEFAULT_ALERT_RULES,
      limits: ALERT_RULE_LIMITS,
      recent: recent.map((r) => ({
        id: Number(r.id),
        rule: r.rule,
        count: r.count,
        threshold: r.threshold,
        windowMinutes: r.window_minutes,
        subject: r.details,
        raisedAt: r.raised_at.toISOString(),
      })),
    };
  };

  app.get('/api/v1/security/alerts', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return view(request.workspaceId);
  });

  app.put('/api/v1/security/alerts', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = alertRulesInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const ws = request.workspaceId;
    const given = ALERT_RULES.flatMap((rule) => {
      const setting = parsed.data.rules[rule];
      return setting ? [{ rule, ...setting }] : [];
    });
    if (given.length === 0) {
      return reply.code(400).send({ error: 'invalid_request', problems: ['rules: name a rule'] });
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('security_alert_rule')
        .values(
          given.map((g) => ({
            workspace_id: ws,
            rule: g.rule as AlertRule,
            enabled: g.enabled,
            threshold: g.threshold,
            window_minutes: g.windowMinutes,
            updated_at: new Date(),
          })),
        )
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'rule']).doUpdateSet((eb) => ({
            enabled: eb.ref('excluded.enabled'),
            threshold: eb.ref('excluded.threshold'),
            window_minutes: eb.ref('excluded.window_minutes'),
            updated_at: eb.ref('excluded.updated_at'),
          })),
        )
        .execute();
      await emit(
        trx,
        { workspaceId: ws, actorId: admin.id },
        { type: 'security_alerts.updated', subjectId: ws, payload: { rules: given } },
      );
    });
    forgetAlertRules(ws);
    return view(ws);
  });
}

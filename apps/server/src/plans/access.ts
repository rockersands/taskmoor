import type { FastifyRequest } from 'fastify';

/**
 * Who may change a Multi-track plan (ADR-122): its owner and site administrators. Everyone else
 * who sees the plan reads it, and a write answers `forbidden` with `edit_plan`. One rule for every
 * plan route: its settings, scenarios and drafts, the auto-scheduler and baselines.
 */
export async function planEditable(request: FastifyRequest, ownerId: number): Promise<boolean> {
  return ownerId === request.user?.id || (await request.authz.isSiteAdmin());
}

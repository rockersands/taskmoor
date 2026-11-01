import type { Database } from '@taskmoor/db';
import type { Catalogue } from '@taskmoor/query';
import type { Kysely } from 'kysely';
import type { QueryPromptContext } from './query';

/** How many names of each kind a prompt carries at most. */
const MAX_NAMES = 200;

/**
 * The names a person may use in a query, as the query editor would offer them (M1-079;
 * AI-014): the tracks they see tickets in with those tracks' releases and areas, the
 * workspace's statuses, priorities, ticket types, close reasons, groups and labels, active
 * people, and the custom fields the person's catalogue holds.
 */
export async function queryVocabulary(
  db: Kysely<Database>,
  workspaceId: number,
  browse: readonly number[] | 'all',
  catalogue: Catalogue,
): Promise<QueryPromptContext['vocabulary']> {
  const ws = workspaceId;
  let tracks = db
    .selectFrom('track')
    .select(['id', 'key', 'name'])
    .where('workspace_id', '=', ws)
    .where('deleted_at', 'is', null)
    .orderBy('key');
  if (browse !== 'all') {
    if (browse.length === 0) tracks = tracks.where('id', '=', -1);
    else tracks = tracks.where('id', 'in', [...browse]);
  }
  const shown = await tracks.limit(MAX_NAMES).execute();
  const trackIds = shown.map((t) => t.id);
  const keyOf = new Map(shown.map((t) => [t.id, t.key]));
  const [statuses, priorities, types, reasons, groups, labels, people, releases, areas] =
    await Promise.all([
      db
        .selectFrom('status')
        .select('name')
        .where('workspace_id', '=', ws)
        .orderBy('sort_order')
        .execute(),
      db
        .selectFrom('priority')
        .select('name')
        .where('workspace_id', '=', ws)
        .orderBy('sort_order')
        .execute(),
      db
        .selectFrom('ticket_type')
        .select(['name', 'owner_track_id'])
        .where('workspace_id', '=', ws)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('close_reason')
        .select('name')
        .where('workspace_id', '=', ws)
        .orderBy('sort_order')
        .execute(),
      db
        .selectFrom('user_group')
        .select('name')
        .where('workspace_id', '=', ws)
        .orderBy('name')
        .limit(MAX_NAMES)
        .execute(),
      db
        .selectFrom('label')
        .select('name')
        .where('workspace_id', '=', ws)
        .orderBy('name')
        .limit(MAX_NAMES)
        .execute(),
      db
        .selectFrom('app_user')
        .select(['name'])
        .where('workspace_id', '=', ws)
        .where('kind', '=', 'person')
        .where('deactivated_at', 'is', null)
        .orderBy('name')
        .limit(MAX_NAMES)
        .execute(),
      trackIds.length === 0
        ? Promise.resolve([])
        : db
            .selectFrom('release')
            .select(['track_id', 'name', 'shipped_at'])
            .where('workspace_id', '=', ws)
            .where('track_id', 'in', trackIds)
            .where('archived_at', 'is', null)
            .orderBy('sort_order')
            .limit(MAX_NAMES)
            .execute(),
      trackIds.length === 0
        ? Promise.resolve([])
        : db
            .selectFrom('area')
            .select(['track_id', 'name'])
            .where('workspace_id', '=', ws)
            .where('track_id', 'in', trackIds)
            .where('archived_at', 'is', null)
            .orderBy('name')
            .limit(MAX_NAMES)
            .execute(),
    ]);
  const typeNames = [
    ...new Set(
      types
        .filter((t) => t.owner_track_id === null || keyOf.has(t.owner_track_id))
        .map((t) => t.name),
    ),
  ];
  return {
    tracks: shown.map((t) => ({ key: t.key, name: t.name })),
    people: people.map((p) => ({ name: p.name })),
    groups: groups.map((g) => g.name),
    statuses: statuses.map((s) => s.name),
    stages: ['new', 'active', 'closed'],
    priorities: priorities.map((p) => p.name),
    ticketTypes: typeNames,
    closeReasons: reasons.map((r) => r.name),
    labels: labels.map((l) => l.name),
    releases: releases.map((r) => ({
      track: keyOf.get(r.track_id) ?? '',
      name: r.name,
      shipped: r.shipped_at !== null,
    })),
    areas: areas.map((a) => ({ track: keyOf.get(a.track_id) ?? '', name: a.name })),
    customFields: catalogue.customs
      .slice(0, MAX_NAMES)
      .map((f) => ({ name: f.name, type: f.type })),
  };
}

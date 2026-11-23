import type { AuthzContext } from '../authz/authorizer';
import type { Catalog } from './catalog';
import { customFieldId } from './form-model';
import type { FieldReader } from './values';

/**
 * Who may read a custom field's definition (`GET /api/v1/fields/:id`; CORE-003, CORE-009), in one
 * place, so that the fields API and the names a ticket's history gives (T-283) never drift apart:
 * a shared field, anyone signed in; a track's own field (local mode), those who browse or
 * administer that track, and site and configuration administrators.
 */
export async function readsFieldsOf(authz: AuthzContext, trackId: number): Promise<boolean> {
  const held = await authz.track(trackId);
  if (held.has('browse_track') || held.has('administer_track')) return true;
  const global = await authz.global();
  return global.has('site_admin') || global.has('configuration_admin');
}

/**
 * The reader of a page of history rows, as far as custom field names go (T-283): signed in or
 * not, and which of the tracks owning the local fields these rows name they may read fields of,
 * each track asked once.
 */
export async function fieldReaderOf(
  authz: AuthzContext,
  signedIn: boolean,
  catalog: Catalog,
  rowFields: Iterable<string>,
): Promise<FieldReader> {
  const tracks = new Set<number>();
  if (!signedIn) return { signedIn, tracks };
  const owners = new Set<number>();
  for (const key of rowFields) {
    const id = customFieldId(key);
    const owner = id === null ? null : (catalog.fields.get(id)?.trackId ?? null);
    if (owner !== null) owners.add(owner);
  }
  for (const trackId of owners) {
    if (await readsFieldsOf(authz, trackId)) tracks.add(trackId);
  }
  return { signedIn, tracks };
}

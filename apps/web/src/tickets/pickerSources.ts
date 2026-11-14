/*
 * The searches behind the create form's people, group and team pickers (T-253, T-265, T-276),
 * shared with the ticket template form (T-350) so both look in the same places.
 */
import { api } from '../api/client';

/** A person, group or team as a picker offers one. */
export interface Found {
  id: number;
  name: string;
}

/** How many matches a picker shows, as the people, group and team searches ask for. */
export const PICKER_LIMIT = 8;

const q = encodeURIComponent;
const named = (rows: Found[]) => rows.map(({ id, name }) => ({ id, name }));

/** People found by name in a track; only those who may be given tickets there, if asked. */
export const findPeople = async (track: string, typed: string, assignable = false) =>
  named(
    (
      await api<{ people: Found[] }>(
        `/people/mentionable?track=${q(track)}&q=${q(typed)}&limit=${PICKER_LIMIT}${assignable ? '&assignable=true' : ''}`,
      )
    ).people,
  );

/** The people a restricted person field allows for a ticket of a type in a track (CORE-009 (2)). */
export const findFieldPeople = async (
  fieldId: number,
  track: string,
  ticketTypeId: number,
  typed: string,
) =>
  named(
    (
      await api<{ people: Found[] }>(
        `/fields/${fieldId}/people?track=${q(track)}&ticketTypeId=${ticketTypeId}&q=${q(typed)}&limit=${PICKER_LIMIT}`,
      )
    ).people,
  );

/** The site's groups a group field offers, by name. */
export const findGroups = async (fieldId: number, typed: string) =>
  named(
    (
      await api<{ groups: Found[] }>(
        `/fields/${fieldId}/groups?q=${q(typed)}&limit=${PICKER_LIMIT}`,
      )
    ).groups,
  );

/** The site's teams whose name holds what was typed; the server keeps to the limit (T-282). */
export const findTeams = async (typed: string) =>
  named((await api<{ teams: Found[] }>(`/teams?query=${q(typed)}&limit=${PICKER_LIMIT}`)).teams);

/**
 * Anyone active in the site, by name or address, for those who set tracks and templates up
 * (`GET /people/lookup`, ADR-114): a template for every track has no track to search in.
 */
export const findSitePeople = async (typed: string) =>
  named(
    (await api<{ people: Found[] }>(`/people/lookup?limit=${PICKER_LIMIT}&q=${q(typed)}`)).people,
  );

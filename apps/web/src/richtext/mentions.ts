import { api } from '../api/client';

/** Someone the editor offers after "@" (NTF-005), and whether they may see the ticket. */
export interface MentionPerson {
  id: number;
  name: string;
  canView: boolean;
}

/** Finds people to mention for what was typed after "@". */
export type MentionSource = (query: string) => Promise<MentionPerson[]>;

/**
 * People to mention from the backend (`GET /api/v1/people/mentionable`): for a ticket, or for
 * a track while the ticket is being created.
 */
export function mentionSource(
  where: { track: string } | { ticket: string | number },
): MentionSource {
  const scope =
    'track' in where
      ? `track=${encodeURIComponent(where.track)}`
      : `ticket=${encodeURIComponent(String(where.ticket))}`;
  return async (query) =>
    (
      await api<{ people: MentionPerson[] }>(
        `/people/mentionable?${scope}&q=${encodeURIComponent(query)}&limit=8`,
      )
    ).people;
}

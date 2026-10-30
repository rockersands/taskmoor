import { api } from '../api/client';
import type { User } from './client';

/** A team as `GET /api/v1/teams` shows it (M1-123, CORE-027). */
export interface TeamSummary {
  id: number;
  name: string;
  description: string;
  lead: { id: number; name: string } | null;
  memberCount: number;
}

export interface TeamDetail {
  team: TeamSummary;
  members: { id: number; name: string; active: boolean }[];
}

export interface TeamChange {
  name?: string;
  description?: string;
  leadId?: number | null;
}

/** The endpoints the teams page uses. Stories and tests pass their own. */
export interface TeamsClient {
  teams: (query: string) => Promise<TeamSummary[]>;
  team: (id: number) => Promise<TeamDetail>;
  createTeam: (body: { name: string; description: string }) => Promise<TeamSummary>;
  updateTeam: (id: number, change: TeamChange) => Promise<TeamSummary>;
  deleteTeam: (id: number) => Promise<void>;
  addTeamMember: (id: number, userId: number) => Promise<void>;
  removeTeamMember: (id: number, userId: number) => Promise<void>;
  /** Active people by name or email, to add to a team. */
  people: (query: string) => Promise<User[]>;
}

export const teamsClient: TeamsClient = {
  teams: async (query) =>
    (
      await api<{ teams: TeamSummary[] }>(
        `/teams${query ? `?query=${encodeURIComponent(query)}` : ''}`,
      )
    ).teams,
  team: (id) => api<TeamDetail>(`/teams/${id}`),
  createTeam: async (body) =>
    (await api<{ team: TeamSummary }>('/teams', { method: 'POST', body })).team,
  updateTeam: async (id, change) =>
    (await api<{ team: TeamSummary }>(`/teams/${id}`, { method: 'PATCH', body: change })).team,
  deleteTeam: async (id) => {
    await api<unknown>(`/teams/${id}`, { method: 'DELETE' });
  },
  addTeamMember: async (id, userId) => {
    await api<unknown>(`/teams/${id}/members/${userId}`, { method: 'PUT' });
  },
  removeTeamMember: async (id, userId) => {
    await api<unknown>(`/teams/${id}/members/${userId}`, { method: 'DELETE' });
  },
  people: async (query) =>
    (
      await api<{ users: User[] }>(
        `/users?status=active&limit=20&query=${encodeURIComponent(query)}`,
      )
    ).users,
};

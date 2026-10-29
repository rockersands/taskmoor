import { api } from '../api/client';

export interface Guardrail {
  name: string;
  limit: number;
  default: number;
  usage: { value: number; where: { kind: string; id: number; name: string } | null };
}

/** The endpoints the guardrails page uses. Stories and tests pass their own. */
export interface GuardrailsClient {
  list: () => Promise<{ guardrails: Guardrail[]; ceiling: number }>;
  set: (name: string, limit: number) => Promise<void>;
}

export const guardrailsClient: GuardrailsClient = {
  list: () => api<{ guardrails: Guardrail[]; ceiling: number }>('/admin/guardrails'),
  set: async (name, limit) => {
    await api<unknown>(`/admin/guardrails/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { limit },
    });
  },
};

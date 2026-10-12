/**
 * The frontend's one way to call the backend. Same origin by default (the backend serves the
 * app, or a proxy sits in front); the Builder (M1) inlines another base URL for split
 * deployments. Cookies travel with every request (ADR-032, same-site layout).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
    this.name = 'ApiError';
  }

  /** The backend's short error code, such as "invalid_setup_token", when it sent one. */
  get code(): string | undefined {
    const body = this.body as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error : undefined;
  }
}

export const API_BASE = '/api/v1';

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const request: RequestInit = { method: init.method ?? 'GET', credentials: 'same-origin' };
  if (init.body !== undefined) {
    request.headers = { 'content-type': 'application/json' };
    request.body = JSON.stringify(init.body);
  }
  const response = await fetch(`${API_BASE}${path}`, request);
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

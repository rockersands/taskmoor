/**
 * Changes the backend accepted from this page: every request other than a read that answered
 * with success, as its method and its path under `/api/v1` (no query). The guided tutorial
 * (ADR-115) listens, so a step that asks the person to make something moves on once the server
 * has it, whichever control or page they used. Nothing here carries a body or an answer.
 */
export interface ApiChange {
  method: string;
  path: string;
}

type Listener = (change: ApiChange) => void;

const listeners = new Set<Listener>();

/** Calls the listener after each accepted change; returns the unsubscribe. */
export function onApiChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every listener; one that throws does not stop the others or the request. */
export function announceApiChange(change: ApiChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // A listener's own problem is no reason to fail the request that succeeded.
    }
  }
}

/** The path under the API base, without origin or query: `/tickets/ABC-1/comments`. */
export function changedPath(url: string, base: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  if (base && withoutQuery.startsWith(base)) return withoutQuery.slice(base.length) || '/';
  try {
    return new URL(withoutQuery, 'http://local').pathname.replace(/^\/api\/v1(?=\/)/, '');
  } catch {
    return withoutQuery;
  }
}

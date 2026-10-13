import { useCallback } from 'react';
import { ApiError } from '../api/client';
import { useSession } from './SessionProvider';

/**
 * Handles a 401 from an endpoint that needs a session: the session ended elsewhere (signed out
 * from another device, expired), so the app re-reads it and shows the sign-in prompt. Returns
 * true when it handled the error.
 */
export function useSessionExpiry(): (error: unknown) => boolean {
  const { refresh } = useSession();
  return useCallback(
    (error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== 401) return false;
      void refresh();
      return true;
    },
    [refresh],
  );
}

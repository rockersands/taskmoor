import { useSession } from '../session/SessionProvider';

/**
 * What a person sees of Administration (ADR-114): everything, the setup pages and the tracks they
 * run, only the tracks they run, or nothing. It decides what the web app offers; the server decides
 * what it answers.
 */
export type AdminAccess = 'site' | 'setup' | 'tracks' | 'none';

export function adminAccessOf(
  user: { isSiteAdmin: boolean; isConfigAdmin?: boolean; managesTracks?: boolean } | null,
): AdminAccess {
  if (user?.isSiteAdmin) return 'site';
  if (user?.isConfigAdmin) return 'setup';
  return user?.managesTracks ? 'tracks' : 'none';
}

/** Null while the session is not known: pages that wait for it should not refuse yet. */
export function useAdminAccess(): AdminAccess | null {
  const { session } = useSession();
  if (session.status === 'loading') return null;
  return adminAccessOf(session.status === 'signed-in' ? session.user : null);
}

/**
 * For a setup page's guard: true once the session shows someone who may not use the setup pages.
 * A site or configuration administrator may.
 */
export function useNotSetupAdmin(): boolean {
  const { session } = useSession();
  return session.status === 'signed-in' && adminAccessOf(session.user) === 'none';
}

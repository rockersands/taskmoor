import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useSession } from '../session/SessionProvider';
import { browserSocket, browserSyncApi } from './browser';
import { SyncEngine } from './engine';
import { deleteSyncDatabase, indexedDbStore, syncDatabaseName } from './store';

const SyncContext = createContext<SyncEngine | null>(null);

/** The signed-in person's sync engine; null while there is none (signed out, no IndexedDB). */
export function useSyncEngine(): SyncEngine | null {
  return useContext(SyncContext);
}

export interface SyncProviderProps {
  children: ReactNode;
  /** Builds the engine for a person; the default needs IndexedDB, so tests without it get none. */
  create?: (userId: number) => Promise<SyncEngine | null>;
}

async function browserEngine(userId: number): Promise<SyncEngine | null> {
  if (typeof indexedDB === 'undefined' || typeof WebSocket === 'undefined') return null;
  const store = await indexedDbStore(syncDatabaseName(userId));
  return new SyncEngine({ api: browserSyncApi, store, connect: browserSocket });
}

/**
 * Runs the client's local copy (M1-032, ADR-013) while someone is signed in: one IndexedDB
 * database per person, deleted when they sign out, so the next person on this browser starts
 * empty. The current position is mirrored on `<html data-sync-position>` for tests and
 * diagnostics.
 */
export function SyncProvider({ children, create = browserEngine }: SyncProviderProps) {
  const { session } = useSession();
  const userId = session.status === 'signed-in' ? session.user.id : null;
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  useEffect(() => {
    if (userId === null) return;
    let live = true;
    let started: SyncEngine | null = null;
    let unsubscribe = () => {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = 2000;
    let trying = false;
    // The first bootstrap needs the server: until it answers the app works from the network
    // as before, and tries again after a pause that doubles up to a minute, or when the
    // browser comes back online.
    const attempt = async (made: SyncEngine) => {
      if (trying) return;
      trying = true;
      clearTimeout(retry);
      try {
        await made.start();
      } catch {
        if (!live) return;
        retry = setTimeout(() => void attempt(made), wait);
        wait = Math.min(wait * 2, 60_000);
        return;
      } finally {
        trying = false;
      }
      window.removeEventListener('online', again);
      if (!live) return;
      document.documentElement.dataset.syncPosition = made.position;
      setEngine(made);
    };
    const again = () => {
      if (started) void attempt(started);
    };
    create(userId).then(
      (made) => {
        if (!made) return;
        // Signed out meanwhile: let go of the database, so it can be deleted.
        if (!live) {
          made.stop();
          return;
        }
        started = made;
        unsubscribe = made.subscribe(() => {
          document.documentElement.dataset.syncPosition = made.position;
        });
        window.addEventListener('online', again);
        void attempt(made);
      },
      () => {
        // No local database (private browsing, storage refused): the app works from the network.
      },
    );
    return () => {
      live = false;
      clearTimeout(retry);
      window.removeEventListener('online', again);
      unsubscribe();
      started?.stop();
      setEngine(null);
      delete document.documentElement.dataset.syncPosition;
    };
  }, [userId, create]);

  // Signing out deletes the person's local copy.
  const [lastUser, setLastUser] = useState<number | null>(null);
  useEffect(() => {
    if (userId !== null) setLastUser(userId);
    else if (lastUser !== null && typeof indexedDB !== 'undefined') {
      void deleteSyncDatabase(syncDatabaseName(lastUser));
      setLastUser(null);
    }
  }, [userId, lastUser]);

  // Back online: send what waited.
  useEffect(() => {
    if (!engine) return;
    const online = () => void engine.flush();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [engine]);

  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>;
}

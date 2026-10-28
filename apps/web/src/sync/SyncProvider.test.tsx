import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN } from '../account/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import type { SyncApi } from './engine';
import { SyncEngine } from './engine';
import { SyncProvider, useSyncEngine } from './SyncProvider';
import { memoryStore } from './store';

function Position() {
  const engine = useSyncEngine();
  return <output aria-label="position">{engine ? engine.position : 'none'}</output>;
}

/** A server that is unreachable until `up` is set. */
function flakyApi() {
  const state = { up: false };
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
  const api: SyncApi = {
    groups: () => (state.up ? Promise.resolve({ position: '5', tracks: [] }) : unreachable()),
    bootstrap: () => unreachable(),
    changes: (after) =>
      state.up ? Promise.resolve({ changes: [], position: after, resync: false }) : unreachable(),
    send: () => unreachable(),
  };
  return { api, state };
}

describe('sync provider (M1-032)', () => {
  it('[NTF-008] keeps trying when the first bootstrap cannot reach the server', async () => {
    const { api, state } = flakyApi();
    const engine = new SyncEngine({ api, store: memoryStore() });
    render(
      <SessionProvider session={SIGNED_IN}>
        <SyncProvider create={async () => engine}>
          <Position />
        </SyncProvider>
      </SessionProvider>,
    );
    // Unreachable: no engine, and the app goes on without one.
    await act(async () => {});
    expect(screen.getByRole('status', { name: 'position' })).toHaveTextContent('none');
    // Back online: it starts.
    state.up = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(document.documentElement.dataset.syncPosition).toBe('5');
  });

  it('[NTF-008] an existing local copy starts offline and catches up later', async () => {
    const { api, state } = flakyApi();
    const store = memoryStore();
    await store.setMeta({ position: '3', tracks: [], clientId: 'c' });
    await store.apply([{ id: 1, track_id: 1, number: 1, summary: 'Kept' }], []);
    const engine = new SyncEngine({ api, store });
    await engine.start();
    expect(engine.position).toBe('3');
    expect(await store.tickets()).toHaveLength(1);
    state.up = true;
    await engine.pull();
    expect(engine.position).toBe('3');
    engine.stop();
  });
});

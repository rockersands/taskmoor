import { ApiError } from '../api/client';
import type {
  FrontendsClient,
  FrontendsView,
  NewFrontend,
  RegisteredFrontend,
} from './FrontendsPage';

/** A backend at 1.4.2 with a kit one release behind, one current, and one in its environment. */
export const FRONTENDS: FrontendsView = {
  self: { origin: 'https://api.example.com', servedVersion: '1.4.2' },
  backend: { version: '1.4.2', frontend: { minimum: '1.3.0', recommended: '1.4.0' } },
  environment: [
    { origin: 'https://tracker.example.com', redirectUris: ['https://tracker.example.com/'] },
  ],
  frontends: [
    {
      id: 1,
      origin: 'https://board.example.org',
      label: 'Wall boards',
      redirectUris: ['https://board.example.org/'],
      websocket: true,
      lastVersion: '1.3.1',
      lastSeenAt: '2026-10-30T09:15:00.000Z',
      addedBy: { id: 1, name: 'Ada Admin' },
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-01T08:00:00.000Z',
      inEnvironment: false,
    },
    {
      id: 2,
      origin: 'https://intranet.example.org',
      label: '',
      redirectUris: [],
      websocket: false,
      lastVersion: null,
      lastSeenAt: null,
      addedBy: null,
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
      inEnvironment: false,
    },
  ],
};

/** A client that keeps what it is given, checking origins the way the backend does. */
export function fakeFrontendsClient(start: FrontendsView = FRONTENDS) {
  let view = structuredClone(start);
  let next = 100;
  const added: NewFrontend[] = [];
  const client: FrontendsClient & { added: NewFrontend[] } = {
    added,
    load: async () => structuredClone(view),
    add: async (input) => {
      added.push(input);
      if (!/^https:\/\/[^/*]+$|^http:\/\/localhost(:\d+)?$/.test(input.origin)) {
        throw new ApiError(400, { error: 'invalid_request', fields: { origin: 'invalid_origin' } });
      }
      if (view.frontends.some((f) => f.origin === input.origin)) {
        throw new ApiError(409, { error: 'origin_exists' });
      }
      const frontend: RegisteredFrontend = {
        id: next++,
        origin: input.origin,
        label: input.label ?? '',
        redirectUris: input.redirectUris ?? [`${input.origin}/`],
        websocket: input.websocket,
        lastVersion: null,
        lastSeenAt: null,
        addedBy: { id: 1, name: 'Ada Admin' },
        createdAt: '2026-10-31T10:00:00.000Z',
        updatedAt: '2026-10-31T10:00:00.000Z',
        inEnvironment: false,
      };
      view = { ...view, frontends: [...view.frontends, frontend] };
      return structuredClone(frontend);
    },
    remove: async (id) => {
      view = { ...view, frontends: view.frontends.filter((f) => f.id !== id) };
    },
  };
  return client;
}

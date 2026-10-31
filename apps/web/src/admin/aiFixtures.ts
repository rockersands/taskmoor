import type { AiClient, AiSettings, AiView, TestResult } from './AiSettingsPage';

/** An AI settings view for stories and tests: the Anthropic API with a stored key. */
export function aiView(change: Partial<AiView['settings']> = {}): AiView {
  return {
    settings: {
      enabled: true,
      strict: false,
      provider: { provider: 'anthropic' },
      features: {},
      tracks: {},
      ...change,
    },
    credentials: [
      {
        slot: 'apiKey',
        last4: 'k9Qe',
        source: 'environment',
        updatedAt: '2026-10-31T09:00:00.000Z',
        updatedBy: null,
      },
    ],
    keyStorage: 'master_key',
    providers: [
      { id: 'anthropic', slots: ['apiKey'], required: ['apiKey'] },
      {
        id: 'bedrock',
        slots: ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken'],
        required: [],
      },
      { id: 'vertex', slots: ['accessToken'], required: [] },
      { id: 'foundry', slots: ['apiKey'], required: ['apiKey'] },
      { id: 'openai-compatible', slots: ['apiKey'], required: [] },
    ],
    features: [
      { id: 'summarize', effort: 'low' },
      { id: 'query-from-text', effort: 'low' },
      { id: 'assisted-creation', effort: 'medium' },
      { id: 'duplicates', effort: 'low' },
    ],
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    tracks: [
      { id: 1, key: 'WEB', name: 'Website', enabled: null, on: true },
      { id: 2, key: 'OPS', name: 'Operations', enabled: null, on: true },
    ],
  };
}

/** A client over an in-memory view, recording what the page sent. */
export function fakeAiClient(start: AiView = aiView(), test?: TestResult) {
  let view = structuredClone(start);
  const sent: {
    saved: AiSettings[];
    keys: [string, string][];
    removed: string[];
    tests: unknown[];
  } = { saved: [], keys: [], removed: [], tests: [] };
  const recompute = () => {
    view.tracks = view.tracks.map((t) => {
      const explicit = view.settings.tracks?.[String(t.id)];
      const on =
        view.settings.enabled && explicit !== false && (!view.settings.strict || explicit === true);
      return { ...t, enabled: explicit ?? null, on };
    });
  };
  recompute();
  const client: AiClient & { sent: typeof sent } = {
    sent,
    load: async () => structuredClone(view),
    save: async (settings) => {
      sent.saved.push(structuredClone(settings));
      view = { ...view, settings: { ...view.settings, ...settings } };
      recompute();
    },
    setKey: async (slot, value) => {
      sent.keys.push([slot, value]);
      view.credentials = [
        ...view.credentials.filter((c) => c.slot !== slot),
        {
          slot,
          last4: value.length >= 12 ? value.slice(-4) : '',
          source: 'admin',
          updatedAt: '2026-10-31T10:00:00.000Z',
          updatedBy: { id: 1, name: 'Ada' },
        },
      ];
    },
    removeKey: async (slot) => {
      sent.removed.push(slot);
      view.credentials = view.credentials.filter((c) => c.slot !== slot);
    },
    test: async (candidate) => {
      sent.tests.push(structuredClone(candidate));
      return (
        test ?? {
          ok: true,
          models: [
            { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
            { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
          ],
        }
      );
    },
    setTrack: async (trackId, enabled) => {
      view.settings.tracks = { ...view.settings.tracks, [String(trackId)]: enabled };
      recompute();
    },
  };
  return client;
}

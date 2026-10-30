import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_CONFIG,
  fillRuntimeConfig,
  parseRuntimeConfig,
  parseSlotText,
  type RuntimeConfig,
  RuntimeConfigError,
  readRuntimeConfig,
} from './config';

/** index.html as the build writes it: the slot after the charset, relative asset URLs after it. */
const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script id="taskmoor-config" type="application/json">{}</script>
    <title>Taskmoor</title>
    <script src="./skin-boot.js"></script>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const PIN = {
  instanceId: '00000000-0000-4000-8000-000000000001',
  instanceKey: `MCowBQYDK2VwAyEA${'A'.repeat(43)}`,
};

describe('runtime configuration', () => {
  it('[OPS-013] reads defaults from an empty slot and from a page that was never filled', () => {
    expect(parseSlotText('')).toEqual({ config: DEFAULT_RUNTIME_CONFIG, problems: [] });
    expect(readRuntimeConfig(BUILT)).toEqual({ config: DEFAULT_RUNTIME_CONFIG, problems: [] });
    expect(readRuntimeConfig('<!doctype html><div id="root"></div>')).toBeNull();
  });

  it('[OPS-013] keeps valid keys, defaults the rest and names every problem', () => {
    const { config, problems } = parseRuntimeConfig({
      routing: 'path',
      apiUrl: 'ftp://api.example.com',
      basePath: 'tracker',
      instanceName: '  Acme  ',
      databaseUrl: 'postgres://x',
    });
    expect(config).toEqual({ ...DEFAULT_RUNTIME_CONFIG, routing: 'path', instanceName: 'Acme' });
    expect(problems).toEqual([
      'apiUrl must use https (plain http only for localhost)',
      'basePath must look like / or /tracker/: tracker',
      'unknown setting "databaseUrl"',
    ]);
    expect(parseSlotText('{routing:').problems).toEqual(['the configuration is not JSON']);
    expect(parseRuntimeConfig([]).problems).toEqual(['the configuration must be a JSON object']);
  });

  it('[IAM-025] accepts https backends, and plain http only on this machine', () => {
    const api = (apiUrl: string) => parseRuntimeConfig({ apiUrl });
    expect(api('https://api.example.com/').config.apiUrl).toBe('https://api.example.com');
    expect(api('https://example.com/tracker/').config.apiUrl).toBe('https://example.com/tracker');
    expect(api('http://localhost:8080').config.apiUrl).toBe('http://localhost:8080');
    expect(api('http://127.0.0.1:8080').problems).toEqual([]);
    expect(api('http://api.example.com').problems).toHaveLength(1);
    expect(api('https://user:pw@api.example.com').problems).toHaveLength(1);
    expect(api('https://api.example.com/?x=1').problems).toHaveLength(1);
    expect(api('not a url').problems).toHaveLength(1);
  });

  it('[OPS-013] takes base paths that are plain folders only', () => {
    for (const basePath of ['/', '/tracker/', '/a/b-c/', '/v1.2/']) {
      expect(parseRuntimeConfig({ basePath }).problems).toEqual([]);
    }
    for (const basePath of ['', 'x/', '/x', '//', '/a/../', '/./', '/a b/', '/"x"/', '/<x>/']) {
      expect(parseRuntimeConfig({ basePath }).problems).toHaveLength(1);
    }
  });

  it('[OPS-013] fills the slot for clean URLs with a base element before any relative URL', () => {
    const html = fillRuntimeConfig(BUILT, {
      routing: 'path',
      basePath: '/tracker/',
      instanceName: 'Acme',
    });
    expect(readRuntimeConfig(html)).toEqual({
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        routing: 'path',
        basePath: '/tracker/',
        instanceName: 'Acme',
      },
      problems: [],
    });
    const base = html.indexOf('<base href="/tracker/" />');
    expect(base).toBeGreaterThan(html.indexOf('<meta charset'));
    expect(base).toBeLessThan(html.indexOf('./skin-boot.js'));
    // Filling again replaces both; hash routing takes the base element away.
    const again = fillRuntimeConfig(html, { routing: 'hash' });
    expect(again).not.toContain('<base');
    expect(readRuntimeConfig(again)?.config).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(fillRuntimeConfig(again, {})).toBe(again);
  });

  it('[OPS-013] refuses unknown keys, invalid values and pages without a slot', () => {
    const fill =
      (settings: Record<string, unknown>, html = BUILT) =>
      () =>
        fillRuntimeConfig(html, settings as Partial<RuntimeConfig>);
    expect(fill({ setupToken: 'x' })).toThrow(RuntimeConfigError);
    expect(fill({ routing: 'pretty' })).toThrow(/routing must be hash or path/);
    expect(fill({}, '<!doctype html><title>x</title>')).toThrow(/no configuration slot/);
  });

  it('[API-017] pins an instance by its id and key together, or not at all', () => {
    expect(parseRuntimeConfig(PIN)).toEqual({
      config: { ...DEFAULT_RUNTIME_CONFIG, ...PIN },
      problems: [],
    });
    const half = parseRuntimeConfig({ instanceId: PIN.instanceId });
    expect(half.config.instanceId).toBe('');
    expect(half.problems).toEqual(['instanceId and instanceKey go together']);
    expect(parseRuntimeConfig({ ...PIN, instanceKey: 'not-a-key' }).problems).toContain(
      'instanceKey must be the public key of the connection manifest',
    );
    expect(parseRuntimeConfig({ ...PIN, instanceId: 'ACME' }).problems).toContain(
      'instanceId must be the instance id of the connection manifest',
    );
  });

  it('[OPS-013] round-trips any valid configuration and never lets a value close the slot', () => {
    const config = fc.record({
      apiUrl: fc.constantFrom('', 'https://api.example.com', 'http://localhost:8080'),
      routing: fc.constantFrom('hash' as const, 'path' as const),
      basePath: fc.constantFrom('/', '/tracker/', '/a/b/'),
      instanceName: fc.string({ maxLength: 100 }).map((s) => s.trim()),
      instanceId: fc.constant(''),
      instanceKey: fc.constant(''),
    });
    const pins = fc.constantFrom({ instanceId: '', instanceKey: '' }, PIN);
    fc.assert(
      fc.property(
        config,
        pins,
        fc.constantFrom('</script>', '<!--', '</SCRIPT >', ''),
        (c, pin, evil) => {
          const value = {
            ...c,
            ...pin,
            instanceName: `${evil}${c.instanceName}`.slice(0, 100).trim(),
          };
          const html = fillRuntimeConfig(BUILT, value);
          expect(readRuntimeConfig(html)).toEqual({ config: value, problems: [] });
          // The page keeps exactly its own script elements.
          expect(html.match(/<\/script>/gi)).toHaveLength(3);
          expect(html.match(/<base /g) ?? []).toHaveLength(value.routing === 'path' ? 1 : 0);
        },
      ),
    );
  });
});

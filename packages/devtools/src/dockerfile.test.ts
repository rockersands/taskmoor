import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every workspace package, as apps/<name> or packages/<name>. */
function workspacePackages(): string[] {
  return ['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${dir}/${e.name}`),
  );
}

describe('Dockerfile', () => {
  // The install layer copies manifests one by one so it caches across source changes; a package
  // missing from the list installs without its dependencies and the bundle step fails.
  it('[OPS-001] copies the manifest of every workspace package before installing', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const missing = workspacePackages().filter(
      (p) => !dockerfile.includes(`COPY ${p}/package.json ${p}/`),
    );
    expect(missing).toEqual([]);
  });
});

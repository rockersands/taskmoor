import { describe, expect, it } from 'vitest';
import { toBase64url, utf8 } from './bytes';
import { validateInputs } from './inputs';
import { saveProject } from './project';
import { seededRandom, systemRandom } from './random';
import {
  KIT_FILE_NAMES,
  kitOutputs,
  kitOutputsFromProject,
  projectKeepsSecrets,
  runSecrets,
  webBuildVersion,
} from './run';
import { generateSecrets } from './secrets';
import { readZip } from './zip';

const VERSIONS = { backendVersion: '1.4.2', kitVersion: '1.4.2' };
const SEED = 'one seed for every run of this test';
/** Credentials made for each run, never written down. */
const fresh = async () => toBase64url(await systemRandom.bytes(18));

/** A web build in miniature, with its version.json. */
const WEB = {
  'index.html': utf8(
    '<!doctype html><html><head><meta charset="UTF-8" /><script id="taskmoor-config" type="application/json">{}</script><script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>',
  ),
  'assets/app.js': utf8('console.log(1);'),
  'version.json': utf8(JSON.stringify({ name: 'taskmoor-web', version: '1.4.2', files: [] })),
};

function inputs() {
  const form = validateInputs({
    backendUrl: 'https://api.example.com',
    frontendUrl: 'https://tracker.example.com/',
    instanceName: 'Acme tracker',
    smtp: { host: 'mail.example.com', port: 587, user: 'robot', from: 'tracker@example.com' },
    ai: { provider: 'anthropic' },
  });
  if (!form.ok) throw new Error('inputs');
  return form.inputs;
}

describe('one Builder run (M1-112)', () => {
  it('[OPS-016] (2) a project file and seed give the bytes of the same inputs and seed', async () => {
    const project = await saveProject(inputs(), { builderVersion: '1.4.2' });
    const fromProject = await kitOutputsFromProject({
      project,
      web: WEB,
      versions: VERSIONS,
      seed: SEED,
    });
    const direct = await kitOutputs({
      inputs: inputs(),
      generated: await generateSecrets(seededRandom(SEED)),
      user: {},
      web: WEB,
      versions: VERSIONS,
    });
    expect(fromProject).toEqual(direct);
    expect(Object.keys(fromProject)).toEqual(Object.keys(KIT_FILE_NAMES));
    expect(Object.keys(readZip(fromProject.backend))).toContain('docker-compose.yml');
    expect(Object.keys(readZip(fromProject.frontend))).toContain('assets/app.js');
    expect(new TextDecoder().decode(fromProject.single)).toContain('console.log(1);');
  });

  it('[OPS-016] a project that keeps its secrets rebuilds the same kits with no seed', async () => {
    const generated = await generateSecrets(seededRandom(SEED));
    const user = { smtpPassword: await fresh(), aiKey: await fresh() };
    const passphrase = await fresh();
    const project = await saveProject(inputs(), {
      builderVersion: '1.4.2',
      secrets: { generated, user },
      passphrase,
    });
    expect(projectKeepsSecrets(project)).toBe(true);
    const run = () => kitOutputsFromProject({ project, web: WEB, versions: VERSIONS, passphrase });
    const [first, second] = [await run(), await run()];
    expect(first).toEqual(second);
    expect(first).toEqual(
      await kitOutputs({ inputs: inputs(), generated, user, web: WEB, versions: VERSIONS }),
    );
    // The SMTP password went to the backend kit and nowhere near the frontend.
    const env = new TextDecoder().decode(readZip(first.backend)['.env']);
    expect(env).toContain(`TASKMOOR_SMTP_PASSWORD=${user.smtpPassword}`);
    expect(new TextDecoder().decode(first.single)).not.toContain(user.smtpPassword);
  });

  it('[OPS-016] keeps the secrets it is given, else makes them from the seed or afresh', async () => {
    const kept = await generateSecrets(seededRandom(SEED));
    expect(await runSecrets(kept, 'another seed, which is ignored')).toBe(kept);
    expect(await runSecrets(null, SEED)).toEqual(kept);
    expect((await runSecrets(null)).instanceId).not.toBe(kept.instanceId);
  });

  it('reads the version a web build was stamped with', () => {
    expect(webBuildVersion(WEB)).toBe('1.4.2');
    expect(webBuildVersion({ 'index.html': utf8('') })).toBeNull();
    expect(webBuildVersion({ 'version.json': utf8('not json') })).toBeNull();
    expect(projectKeepsSecrets('{"format":"taskmoor-builder-project-1"}')).toBe(false);
    expect(projectKeepsSecrets('not json')).toBe(false);
  });
});

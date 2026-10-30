import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  backendKit,
  buildKits,
  frontendKit,
  generateSecrets,
  loadProject,
  seededRandom,
  systemRandom,
  type UserSecrets,
  writeZip,
} from '@taskmoor/builder-core';

/**
 * The Builder on the command line (M1-111; OPS-016): the same core as the web Builder, run
 * from a project file. It writes the backend kit's core as a zip, the frontend kit as a zip and
 * as a single index.html. With a seed (and the same project file and build) every byte matches
 * the web Builder's output; without one, the secrets come from the system's generator.
 */
export interface BuilderRun {
  /** The project file's text. */
  project: string;
  /** The built frontend: apps/web/dist, or the folder the image ships. */
  webDir: string;
  outDir: string;
  /** Reproducible secrets, for rebuilding a kit; never for a first install. */
  seed?: string;
  passphrase?: string;
  /** The SMTP password and AI key, when the project keeps them encrypted or the run gives them. */
  user?: UserSecrets;
  versions: { backendVersion: string; kitVersion: string };
  /** The image repository the backend kit pins, `ghcr.io/rockersands/taskmoor` by default. */
  image?: string;
}

function readTree(dir: string, root = dir): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      return e.isDirectory()
        ? Object.entries(readTree(path, root))
        : [[relative(root, path).split('\\').join('/'), new Uint8Array(readFileSync(path))]];
    }),
  );
}

export const OUTPUTS = {
  backend: 'taskmoor-backend-kit.zip',
  frontend: 'taskmoor-frontend-kit.zip',
  single: 'taskmoor-frontend-single.html',
} as const;

export async function runBuilder(run: BuilderRun): Promise<Record<keyof typeof OUTPUTS, string>> {
  const project = await loadProject(run.project, run.passphrase);
  const generated =
    project.secrets?.generated ??
    (await generateSecrets(run.seed ? seededRandom(run.seed) : systemRandom));
  const user = { ...project.secrets?.user, ...run.user };
  const kits = await buildKits(project.inputs, generated, user, run.versions);
  const web = readTree(run.webDir);
  mkdirSync(run.outDir, { recursive: true });
  const out = Object.fromEntries(
    Object.entries(OUTPUTS).map(([k, name]) => [k, join(run.outDir, name)]),
  ) as Record<keyof typeof OUTPUTS, string>;
  writeFileSync(
    out.backend,
    writeZip(backendKit(kits, project.inputs, run.image ? { image: run.image } : {})),
  );
  writeFileSync(out.frontend, writeZip(await frontendKit(kits, web)));
  const single = await frontendKit(kits, web, { singleFile: true });
  writeFileSync(out.single, single['index.html'] ?? '');
  return out;
}

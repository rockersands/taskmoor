import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  KIT_FILE_NAMES,
  type KitOutput,
  kitOutputsFromProject,
  type UserSecrets,
  type WebFiles,
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

/** Every file under a folder, by its path relative to it with forward slashes. */
export function readTree(dir: string, root = dir): WebFiles {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      return e.isDirectory()
        ? Object.entries(readTree(path, root))
        : [[relative(root, path).split('\\').join('/'), new Uint8Array(readFileSync(path))]];
    }),
  );
}

/** The files a run writes; the Builder page offers the same three as downloads (M1-112). */
export const OUTPUTS = KIT_FILE_NAMES;

/** The core's run with the web build read from disk and the three files written to `outDir`. */
export async function runBuilder(run: BuilderRun): Promise<Record<KitOutput, string>> {
  const outputs = await kitOutputsFromProject({
    project: run.project,
    web: readTree(run.webDir),
    versions: run.versions,
    seed: run.seed,
    passphrase: run.passphrase,
    user: run.user,
    image: run.image,
  });
  mkdirSync(run.outDir, { recursive: true });
  const out = Object.fromEntries(
    Object.entries(OUTPUTS).map(([k, name]) => [k, join(run.outDir, name)]),
  ) as Record<KitOutput, string>;
  for (const key of Object.keys(OUTPUTS) as KitOutput[]) writeFileSync(out[key], outputs[key]);
  return out;
}

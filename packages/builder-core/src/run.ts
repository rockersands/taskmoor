import { parseManifest, MANIFEST_FILE as WEB_MANIFEST } from '@taskmoor/webconfig';
import { backendKit } from './backend';
import { utf8 } from './bytes';
import { frontendKit, type WebFiles } from './frontend';
import type { BuilderInputs, UserSecrets } from './inputs';
import { buildKits } from './kits';
import { loadProject } from './project';
import { seededRandom, systemRandom } from './random';
import { type GeneratedSecrets, generateSecrets } from './secrets';
import { writeZip } from './zip';

/**
 * One Builder run from start to finish (M1-112; OPS-016 (2)): the three files both faces of
 * the Builder hand out, from the inputs, the secrets and the web build. The CLI calls it with
 * files read from disk and writes the results; the Builder page calls it with the web build it
 * carries and offers the results as downloads. Nothing here touches a file system or the
 * network, so the two produce the same bytes for the same project file and seed.
 */
export const KIT_FILE_NAMES = {
  backend: 'taskmoor-backend-kit.zip',
  frontend: 'taskmoor-frontend-kit.zip',
  single: 'taskmoor-frontend-single.html',
} as const;

export type KitOutput = keyof typeof KIT_FILE_NAMES;
export type KitOutputs = Record<KitOutput, Uint8Array<ArrayBuffer>>;

export interface KitVersions {
  backendVersion: string;
  kitVersion: string;
}

export interface KitRun {
  inputs: BuilderInputs;
  generated: GeneratedSecrets;
  user: UserSecrets;
  web: WebFiles;
  versions: KitVersions;
  /** The image repository the backend kit pins; `ghcr.io/rockersands/taskmoor` by default. */
  image?: string | undefined;
}

/** The backend kit as a zip, the frontend kit as a zip and as one index.html. */
export async function kitOutputs(run: KitRun): Promise<KitOutputs> {
  const kits = await buildKits(run.inputs, run.generated, run.user, run.versions);
  const single = (await frontendKit(kits, run.web, { singleFile: true }))['index.html'] ?? '';
  return {
    backend: writeZip(backendKit(kits, run.inputs, run.image ? { image: run.image } : {})),
    frontend: writeZip(await frontendKit(kits, run.web)),
    single: typeof single === 'string' ? utf8(single) : new Uint8Array(single),
  };
}

/**
 * The secrets of a run: the ones a project file keeps (opened with its passphrase), else fresh
 * ones from the seed when there is one, else from the platform's generator.
 */
export async function runSecrets(
  kept: GeneratedSecrets | null | undefined,
  seed?: string,
): Promise<GeneratedSecrets> {
  return kept ?? generateSecrets(seed ? seededRandom(seed) : systemRandom);
}

export interface ProjectRun {
  /** The project file's text. */
  project: string;
  web: WebFiles;
  versions: KitVersions;
  seed?: string | undefined;
  passphrase?: string | undefined;
  /** The SMTP password and AI key, over what the project keeps. */
  user?: UserSecrets | undefined;
  image?: string | undefined;
}

/** A run from a project file: what `pnpm builder --project` does, without the files. */
export async function kitOutputsFromProject(run: ProjectRun): Promise<KitOutputs> {
  const project = await loadProject(run.project, run.passphrase);
  return kitOutputs({
    inputs: project.inputs,
    generated: await runSecrets(project.secrets?.generated, run.seed),
    user: { ...project.secrets?.user, ...run.user },
    web: run.web,
    versions: run.versions,
    image: run.image,
  });
}

/** Whether a project file keeps secrets, which only its passphrase opens. */
export function projectKeepsSecrets(text: string): boolean {
  try {
    const file = JSON.parse(text) as { secrets?: unknown };
    return typeof file === 'object' && file !== null && file.secrets !== undefined;
  } catch {
    return false;
  }
}

/** The version a web build was stamped with (its version.json, ADR-066); null without one. */
export function webBuildVersion(web: WebFiles): string | null {
  const file = web[WEB_MANIFEST];
  if (!file) return null;
  try {
    return parseManifest(JSON.parse(new TextDecoder().decode(file))).version;
  } catch {
    return null;
  }
}

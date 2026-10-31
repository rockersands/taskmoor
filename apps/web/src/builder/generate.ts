import {
  type BuilderInputs,
  type GeneratedSecrets,
  KIT_FILE_NAMES,
  type KitOutput,
  type KitOutputs,
  kitOutputs,
  runSecrets,
  type UserSecrets,
  type WebFiles,
} from '@taskmoor/builder-core';

/**
 * The Builder page's run (M1-112; OPS-016 (2)): the core's own, with the secrets the page holds
 * (kept by a project file, or made in an earlier run of this page) or fresh ones from the seed
 * or the browser's generator. `pnpm builder` runs the same core function, so a project file and
 * seed give the same bytes on either face.
 */
export interface PageRun {
  inputs: BuilderInputs;
  user: UserSecrets;
  /** The secrets the page already holds; null makes new ones. */
  secrets: GeneratedSecrets | null;
  /** Empty for the browser's generator. */
  seed: string;
  web: WebFiles;
  version: string;
}

export interface PageResult {
  secrets: GeneratedSecrets;
  outputs: KitOutputs;
}

export async function generateKits(run: PageRun): Promise<PageResult> {
  const secrets = await runSecrets(run.secrets, run.seed || undefined);
  const outputs = await kitOutputs({
    inputs: run.inputs,
    generated: secrets,
    user: run.user,
    web: run.web,
    versions: { backendVersion: run.version, kitVersion: run.version },
  });
  return { secrets, outputs };
}

export const OUTPUT_ORDER: readonly KitOutput[] = ['backend', 'frontend', 'single'];
export const OUTPUT_TYPES: Record<KitOutput, string> = {
  backend: 'application/zip',
  frontend: 'application/zip',
  single: 'text/html',
};
export const outputName = (key: KitOutput) => KIT_FILE_NAMES[key];

/** A file's SHA-256 in hex, shown beside each download to compare with the CLI's. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A Blob URL for a file the page made; revoke it when it is replaced. */
export const blobUrl = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
  URL.createObjectURL(new Blob([bytes], { type }));

/** Hands a file to the person through a Blob URL and a download link clicked for them. */
export function saveFile(name: string, bytes: Uint8Array<ArrayBuffer>, type: string): void {
  const url = blobUrl(bytes, type);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has the file once the click is handled; keep the URL a while for slow ones.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

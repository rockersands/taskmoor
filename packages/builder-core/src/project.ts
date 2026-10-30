import { canonicalJson, fromBase64url, toBase64url, utf8 } from './bytes';
import { type BuilderInputs, type UserSecrets, validateInputs } from './inputs';
import { type RandomSource, systemRandom } from './random';
import type { GeneratedSecrets } from './secrets';

/**
 * The project file (M1-109; OPS-016): the Builder's inputs, saved to regenerate both kits on an
 * upgrade or a rebrand. Secrets are left out, or kept only when encrypted with a passphrase
 * (PBKDF2-SHA-256, 600,000 rounds, then AES-256-GCM), so the file can sit in a repository or a
 * shared drive. One input set and passphrase give one file, keys in a fixed order.
 */
export const PROJECT_FORMAT = 'taskmoor-builder-project-1';
const ITERATIONS = 600_000;

export interface EncryptedSecrets {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  cipher: 'AES-256-GCM';
  iv: string;
  data: string;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  /** The Builder that wrote it. */
  builderVersion: string;
  inputs: BuilderInputs;
  secrets?: EncryptedSecrets;
}

export interface ProjectSecrets {
  generated: GeneratedSecrets;
  user: UserSecrets;
}

export class ProjectError extends Error {
  constructor(readonly code: 'not_a_project' | 'invalid_inputs' | 'wrong_passphrase') {
    super(code);
    this.name = 'ProjectError';
  }
}

async function keyFor(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The project file's text. With a passphrase, the secrets ride along encrypted. */
export async function saveProject(
  inputs: BuilderInputs,
  options: {
    builderVersion: string;
    secrets?: ProjectSecrets;
    passphrase?: string;
    random?: RandomSource;
  },
): Promise<string> {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    builderVersion: options.builderVersion,
    inputs,
  };
  if (options.secrets && options.passphrase) {
    const random = options.random ?? systemRandom;
    const salt = await random.bytes(16);
    const iv = await random.bytes(12);
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await keyFor(options.passphrase, salt, ITERATIONS),
      utf8(canonicalJson(options.secrets)),
    );
    file.secrets = {
      kdf: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: toBase64url(salt),
      cipher: 'AES-256-GCM',
      iv: toBase64url(iv),
      data: toBase64url(new Uint8Array(data)),
    };
  }
  return `${JSON.stringify(JSON.parse(canonicalJson(file)), null, 2)}\n`;
}

/** Reads a project file; its secrets only with the right passphrase. */
export async function loadProject(
  text: string,
  passphrase?: string,
): Promise<{ inputs: BuilderInputs; builderVersion: string; secrets: ProjectSecrets | null }> {
  let file: ProjectFile;
  try {
    file = JSON.parse(text) as ProjectFile;
  } catch {
    throw new ProjectError('not_a_project');
  }
  if (file?.format !== PROJECT_FORMAT) throw new ProjectError('not_a_project');
  const checked = validateInputs(file.inputs);
  if (!checked.ok) throw new ProjectError('invalid_inputs');
  let secrets: ProjectSecrets | null = null;
  if (file.secrets && passphrase !== undefined) {
    const s = file.secrets;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64url(s.iv) },
        await keyFor(passphrase, fromBase64url(s.salt), s.iterations),
        fromBase64url(s.data),
      );
      secrets = JSON.parse(new TextDecoder().decode(plain)) as ProjectSecrets;
    } catch {
      throw new ProjectError('wrong_passphrase');
    }
  }
  return { inputs: checked.inputs, builderVersion: file.builderVersion, secrets };
}

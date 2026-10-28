import { randomBytes } from 'node:crypto';

/**
 * Object keys (ADR-040). A stored file's key is made here, from randomness and the workspace
 * id, and never from anything a person typed: a file name is display text in the database and
 * nothing else. Keys spread over 65,536 folders by their first four hex digits, so no folder
 * grows past a few hundred files at millions of attachments.
 *
 * Both stores refuse any key that does not have exactly this shape, so a key can never carry a
 * path separator, a dot segment, a drive letter or a NUL into a file system path or a bucket.
 */
const KEY = /^w([1-9][0-9]{0,9})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{32})$/;

export function newObjectKey(workspaceId: number): string {
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1 || workspaceId > 2_147_483_647) {
    throw new RangeError('workspace id out of range');
  }
  const hex = randomBytes(16).toString('hex');
  return `w${workspaceId}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

export function isObjectKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const match = KEY.exec(key);
  if (!match) return false;
  const hex = match[4] as string;
  return match[2] === hex.slice(0, 2) && match[3] === hex.slice(2, 4);
}

export class InvalidKeyError extends Error {
  readonly code = 'invalid_key';
  constructor() {
    // The key itself is not repeated: it is never user input, so a bad one is a bug to log.
    super('not an object key');
  }
}

export function assertObjectKey(key: unknown): asserts key is string {
  if (!isObjectKey(key)) throw new InvalidKeyError();
}

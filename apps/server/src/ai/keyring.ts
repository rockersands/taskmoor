import {
  ExternalKek,
  type ExternalKeyService,
  type KeyEncryptionKey,
  KeyRing,
  LocalKek,
  type PepperRing,
} from '@taskmoor/iam';

/**
 * Where AI credentials' data keys are wrapped (M1-075; IAM-020; ADR-098), first match wins:
 *
 * 1. a key service (KMS or Vault) when one is plugged in (`external`);
 * 2. `TASKMOOR_MASTER_KEY`, which the Builder's backend kit writes;
 * 3. the install's active password pepper (`TASKMOOR_PASSWORD_PEPPER` or the keyring in
 *    `TASKMOOR_DATA`), so a Compose install without a master key can still store keys; backups
 *    carry that keyring;
 * 4. none: credentials cannot be stored, and the API says so.
 *
 * Older keys stay readable: `TASKMOOR_MASTER_KEY_PREVIOUS` (comma-separated) after a master key
 * change, the master key itself after a move to a key service, and every pepper the keyring
 * knows. The server re-wraps data keys under the active key at start.
 */
export type KeyStorage = 'kms' | 'vault' | 'master_key' | 'pepper' | 'none';

export interface AiKeyRing {
  ring: KeyRing;
  storage: KeyStorage;
}

export function aiKeyRing(options: {
  masterKey?: string | undefined;
  previousMasterKeys?: readonly string[] | undefined;
  peppers?: PepperRing | undefined;
  external?: ExternalKeyService | undefined;
}): AiKeyRing {
  const master = options.masterKey ? LocalKek.fromSecret(options.masterKey) : undefined;
  const previous = (options.previousMasterKeys ?? []).map((k) => LocalKek.fromSecret(k));
  const pepper = options.peppers?.active ? LocalKek.fromPepper(options.peppers.active) : undefined;
  const external = options.external ? new ExternalKek(options.external) : undefined;
  const active: KeyEncryptionKey | undefined = external ?? master ?? pepper;
  const others = [master, pepper, ...previous].filter(
    (k): k is LocalKek => k !== undefined && k !== active,
  );
  const lookup = (id: string) => {
    if (!id.startsWith('pepper:')) return undefined;
    const found = options.peppers?.find(id.slice('pepper:'.length));
    return found ? LocalKek.fromPepper(found) : undefined;
  };
  const storage: KeyStorage = options.external
    ? options.external.kind
    : master
      ? 'master_key'
      : pepper
        ? 'pepper'
        : 'none';
  return { ring: new KeyRing(active, others, lookup), storage };
}

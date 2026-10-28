import { join } from 'node:path';
import { LocalStore, type ObjectStore, S3Store, type StorageKind } from '@taskmoor/storage';
import type { ServerConfig } from '../config';
import { type Scanner, scannerFromSetting } from './scan';

/**
 * Where attachments live in this process (ADR-040): the store new files go to, every store
 * that can be read (a row names its own, so files stay readable after a switch from local disk
 * to a bucket), the scanner, and how long a signed download URL lives.
 */
export interface AttachmentStores {
  /** Null when no store is configured: uploads are refused with 503 until one is. */
  active: ObjectStore | null;
  stores: Partial<Record<StorageKind, ObjectStore>>;
  scanner: Scanner | null;
  /** Seconds a presigned URL stays valid (S3). */
  urlTtl: number;
}

export const NO_STORAGE: AttachmentStores = {
  active: null,
  stores: {},
  scanner: null,
  urlTtl: 300,
};

/** Stores for tests and tools: one store, active, no scanner unless given. */
export function storesOf(
  active: ObjectStore,
  options: { others?: ObjectStore[]; scanner?: Scanner | null; urlTtl?: number } = {},
): AttachmentStores {
  const stores: Partial<Record<StorageKind, ObjectStore>> = { [active.kind]: active };
  for (const other of options.others ?? []) stores[other.kind] = other;
  return { active, stores, scanner: options.scanner ?? null, urlTtl: options.urlTtl ?? 300 };
}

/** The stores the configuration describes; local disk needs a files or data directory. */
export async function attachmentStores(config: ServerConfig): Promise<AttachmentStores> {
  const files =
    config.storage.filesDir === 'off'
      ? null
      : (config.storage.filesDir ?? (config.dataDir ? join(config.dataDir, 'files') : null));
  const stores: Partial<Record<StorageKind, ObjectStore>> = {};
  if (files) stores.local = await LocalStore.open(files);
  if (config.storage.s3) stores.s3 = new S3Store(config.storage.s3);
  const kind = config.storage.backend ?? (config.storage.s3 ? 's3' : 'local');
  return {
    active: stores[kind] ?? null,
    stores,
    scanner: scannerFromSetting(config.storage.scanClamd),
    urlTtl: config.storage.urlTtl,
  };
}

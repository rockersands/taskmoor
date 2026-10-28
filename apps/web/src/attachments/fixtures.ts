import type { Attachment, AttachmentClient, AttachmentList, ZipListing } from './client';

// Synthetic attachments for stories and tests (M1-016).

const base = {
  sha256: 'a'.repeat(64),
  declaredType: 'application/octet-stream',
  author: { id: 2, name: 'Ada Lovelace' },
  createdAt: '2026-10-20T09:30:00Z',
  scan: 'clean',
  thumbnail: false,
  width: null,
  height: null,
  canDelete: true,
} as const;

export const ATTACHMENTS: Attachment[] = [
  {
    ...base,
    id: 11,
    name: 'checkout-error.png',
    size: 182_340,
    contentType: 'image/png',
    declaredType: 'image/png',
    kind: 'image',
    thumbnail: true,
    width: 1280,
    height: 720,
  },
  {
    ...base,
    id: 12,
    name: 'payment-flow-spec.pdf',
    size: 2_457_600,
    contentType: 'application/pdf',
    declaredType: 'application/pdf',
    kind: 'pdf',
    author: { id: 3, name: 'Grace Hopper' },
    canDelete: false,
  },
  {
    ...base,
    id: 13,
    name: 'server.log',
    size: 48_213,
    contentType: 'text/plain; charset=utf-8',
    declaredType: 'text/plain',
    kind: 'text',
  },
  {
    ...base,
    id: 14,
    name: 'crash-dumps.zip',
    size: 73_400_320,
    contentType: 'application/zip',
    declaredType: 'application/zip',
    kind: 'zip',
    canDelete: false,
  },
  {
    ...base,
    id: 15,
    name: 'installer.exe',
    size: 1_288_490_188,
    contentType: 'application/octet-stream',
    kind: 'other',
    scan: 'pending',
  },
  {
    ...base,
    id: 16,
    name: 'invoice.pdf.exe',
    size: 81_920,
    contentType: 'application/octet-stream',
    kind: 'other',
    scan: 'infected',
    author: null,
    canDelete: false,
  },
];

export const ZIP_LISTING: ZipListing = {
  total: 4,
  truncated: false,
  entries: [
    { index: 0, path: 'dumps/', size: 0, directory: true, encrypted: false, unsafe: false },
    {
      index: 1,
      path: 'dumps/2026-10-20.dmp',
      size: 52_428_800,
      directory: false,
      encrypted: false,
      unsafe: false,
    },
    {
      index: 2,
      path: 'dumps/README.txt',
      size: 1_204,
      directory: false,
      encrypted: false,
      unsafe: false,
    },
    {
      index: 3,
      path: '../../etc/cron.d/job',
      size: 42,
      directory: false,
      encrypted: false,
      unsafe: true,
    },
  ],
};

export const SERVER_LOG = [
  '2026-10-20T09:12:01Z INFO  checkout started basket=8812',
  '2026-10-20T09:12:02Z WARN  payment provider slow (2.4 s)',
  '2026-10-20T09:12:05Z ERROR payment declined: card expired',
].join('\n');

/** A soft-coloured square, so stories show a picture without a server. */
const SWATCH =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#f5b896"/><circle cx="22" cy="24" r="8" fill="#fcfaf7"/><path d="M8 56 28 34l10 10 8-8 10 20z" fill="#a1452a"/></svg>',
  );

/** An in-memory attachment store, so uploads and deletes in stories behave like the real thing. */
export function fakeAttachmentClient(
  list: Partial<AttachmentList> = {},
  overrides: Partial<AttachmentClient> = {},
): AttachmentClient {
  let attachments = [...(list.attachments ?? ATTACHMENTS)];
  let next = 100;
  return {
    list: async () => ({
      attachments,
      maxFileSize: list.maxFileSize ?? 1024 ** 3,
      canCreate: list.canCreate ?? true,
      available: list.available ?? true,
      locked: list.locked ?? null,
    }),
    upload: async (file) => {
      const added: Attachment = {
        ...base,
        id: next++,
        name: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        declaredType: file.type || 'application/octet-stream',
        kind: file.type.startsWith('image/') ? 'image' : 'other',
        createdAt: '2026-10-28T12:00:00Z',
      };
      attachments = [...attachments, added];
      return added;
    },
    remove: async (a) => {
      attachments = attachments.filter((x) => x.id !== a.id);
    },
    text: async () => ({ text: SERVER_LOG, truncated: false }),
    entries: async () => ZIP_LISTING,
    urls: {
      content: (a) => (a.kind === 'image' ? SWATCH : `#download-${a.id}`),
      thumbnail: () => SWATCH,
      entry: (a, index) => `#download-${a.id}-${index}`,
      archive: () => '#download-all',
    },
    ...overrides,
  };
}

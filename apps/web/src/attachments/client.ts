import { API_BASE, ApiError, api } from '../api/client';

/** An attachment as `GET /api/v1/tickets/:id/attachments` shows it (CORE-021). */
export interface Attachment {
  id: number;
  name: string;
  size: number;
  contentType: string;
  declaredType: string;
  kind: 'image' | 'pdf' | 'video' | 'text' | 'zip' | 'other';
  sha256: string;
  author: { id: number; name: string } | null;
  createdAt: string;
  scan: 'pending' | 'clean' | 'infected' | 'failed';
  thumbnail: boolean;
  width: number | null;
  height: number | null;
  canDelete: boolean;
}

export interface AttachmentList {
  attachments: Attachment[];
  maxFileSize: number;
  canCreate: boolean;
  /** False when the server has no file store configured. */
  available: boolean;
}

export interface ZipEntry {
  index: number;
  path: string;
  size: number;
  directory: boolean;
  encrypted: boolean;
  unsafe: boolean;
}

export interface ZipListing {
  entries: ZipEntry[];
  total: number;
  truncated: boolean;
}

/** Where the browser fetches files: links and image sources, never through `fetch`. */
export interface AttachmentUrls {
  content: (a: Attachment, inline?: boolean) => string;
  thumbnail: (a: Attachment) => string;
  entry: (a: Attachment, index: number) => string;
  archive: () => string;
}

/** The endpoints the panel uses for one ticket. Stories and some tests pass their own. */
export interface AttachmentClient {
  list: () => Promise<AttachmentList>;
  upload: (file: File) => Promise<Attachment>;
  remove: (a: Attachment) => Promise<void>;
  text: (a: Attachment) => Promise<{ text: string; truncated: boolean }>;
  entries: (a: Attachment) => Promise<ZipListing>;
  urls: AttachmentUrls;
}

export function attachmentClient(ticket: number | string): AttachmentClient {
  const base = `/tickets/${encodeURIComponent(String(ticket))}/attachments`;
  const href = (path: string) => `${API_BASE}${base}${path}`;
  return {
    list: () => api<AttachmentList>(base),
    upload: async (file) => {
      const form = new FormData();
      form.append('file', file, file.name);
      const response = await fetch(`${API_BASE}${base}`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      const text = await response.text();
      const body: unknown = text ? JSON.parse(text) : null;
      if (!response.ok) throw new ApiError(response.status, body);
      return (body as { attachment: Attachment }).attachment;
    },
    remove: async (a) => {
      await api(`${base}/${a.id}`, { method: 'DELETE' });
    },
    text: (a) => api<{ text: string; truncated: boolean }>(`${base}/${a.id}/text`),
    entries: (a) => api<ZipListing>(`${base}/${a.id}/entries`),
    urls: {
      content: (a, inline = false) =>
        href(`/${a.id}/content${inline ? '?disposition=inline' : ''}`),
      thumbnail: (a) => href(`/${a.id}/thumbnail`),
      entry: (a, index) => href(`/${a.id}/entries/${index}/content`),
      archive: () => href('/archive'),
    },
  };
}

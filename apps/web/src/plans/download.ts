import { CSV_CONTENT_TYPE, withBom } from '@taskmoor/webconfig';

/** Hands a file the page made to the browser's own download: a Blob URL and a link clicked. */
export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
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

/**
 * A CSV file the page made, as the browser saves it: UTF-8 with the byte-order mark in front,
 * exactly once (T-252), typed as every CSV export is.
 */
export const csvBlob = (text: string): Blob =>
  new Blob([withBom(text)], { type: CSV_CONTENT_TYPE });

/**
 * A plan's file: its name reduced to letters, digits and safe marks, the view and the day. Letters
 * of any language stay, since a browser names the download itself and no header carries it.
 */
export function fileName(plan: string, view: string, day: string, extension: string): string {
  const safe = plan
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${safe || 'plan'}-${view}-${day}.${extension}`;
}

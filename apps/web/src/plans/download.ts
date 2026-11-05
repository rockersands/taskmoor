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

/** A plan's file: its name reduced to safe characters, the view and the day. */
export function fileName(plan: string, view: string, day: string, extension: string): string {
  const safe = plan
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${safe || 'plan'}-${view}-${day}.${extension}`;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Reads server-sent events from a response body; tolerant of CRLF and split chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): SseEvent | undefined => {
    if (data.length === 0) {
      event = undefined;
      return undefined;
    }
    const out: SseEvent = { ...(event ? { event } : {}), data: data.join('\n') };
    event = undefined;
    data = [];
    return out;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A last line without its newline still counts.
      if (done && buffer !== '') buffer += '\n';
      let newline = buffer.search(/\r?\n/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
        if (line === '') {
          const out = flush();
          if (out) yield out;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        newline = buffer.search(/\r?\n/);
      }
      if (done) {
        const out = flush();
        if (out) yield out;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Encodes events the way a server writes them (for fakes and fixtures). */
export function encodeSse(events: readonly SseEvent[]): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${e.data}\n\n`).join('');
}

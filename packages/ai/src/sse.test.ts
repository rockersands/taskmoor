import { describe, expect, it } from 'vitest';
import { encodeSse, readSse, type SseEvent } from './sse';

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function read(chunks: string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of readSse(bodyOf(chunks))) events.push(event);
  return events;
}

describe('server-sent events', () => {
  it('[AI-007] reads events split across chunks, with CRLF, comments and multi-line data', async () => {
    expect(
      await read([
        ': keep-alive\r\n\r\nevent: delta\r\nda',
        'ta: {"a":1}\r\n\r\ndata: line one\ndata: line two\n\n',
        'data: [DONE]',
      ]),
    ).toEqual([
      { event: 'delta', data: '{"a":1}' },
      { data: 'line one\nline two' },
      { data: '[DONE]' },
    ]);
  });

  it('[AI-007] reads back what it writes', async () => {
    const events = [{ event: 'message_start', data: '{"x":"é"}' }, { data: 'plain' }];
    expect(await read([encodeSse(events)])).toEqual(events);
  });
});

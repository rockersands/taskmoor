import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import { afterAll, describe, expect, it } from 'vitest';
import { EndpointEmbedder } from './endpoint';
import { bundledModelDir, LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LocalEmbedder } from './local';
import { dot } from './types';
import { WordPieceTokenizer } from './wordpiece';

const vocab = readFileSync(join(bundledModelDir(), 'vocab.txt'), 'utf8');
const tokenizer = new WordPieceTokenizer(vocab);
const pieces = (text: string) => {
  const byId = vocab.split('\n');
  return tokenizer.encode(text).ids.map((id) => byId[id]);
};

describe('the bundled tokenizer (M1-078)', () => {
  it('[AI-012] gives the vocabulary’s ids for a known sentence', () => {
    expect(tokenizer.size).toBe(30522);
    expect(tokenizer.encode('hello world').ids).toEqual([101, 7592, 2088, 102]);
    expect([tokenizer.padId, tokenizer.unkId, tokenizer.clsId, tokenizer.sepId]).toEqual([
      0, 100, 101, 102,
    ]);
  });

  it('[AI-012] lower-cases, strips accents and splits punctuation and ideographs', () => {
    expect(tokenizer.encode('Héllo,   WORLD!').ids).toEqual(
      tokenizer.encode('hello , world !').ids,
    );
    expect(pieces('naïve café')).toEqual(pieces('naive cafe'));
    // ASCII symbols are punctuation too; control characters vanish; tabs are white space.
    expect(pieces('a$b\tc\u0007d')).toEqual(['[CLS]', 'a', '$', 'b', 'cd', '[SEP]']);
    // Each ideograph is a word of its own.
    expect(pieces('中文')).toEqual(['[CLS]', '中', '文', '[SEP]']);
  });

  it('[AI-012] cuts words into the longest pieces, marks inner pieces and gives [UNK] for the rest', () => {
    const word = pieces('tokenization');
    expect(word[0]).toBe('[CLS]');
    expect(word.slice(1, -1).join('').replaceAll('##', '')).toBe('tokenization');
    expect(word.slice(2, -1).every((p) => p?.startsWith('##'))).toBe(true);
    expect(pieces('x'.repeat(101))).toEqual(['[CLS]', '[UNK]', '[SEP]']);
    // A synthetic vocabulary shows the greedy match and the all-or-nothing rule.
    const tiny = new WordPieceTokenizer(
      ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'un', 'unf', '##a', '##ff', '##able', 'fix'].join('\n'),
    );
    expect(tiny.encode('unaffable fix').ids).toEqual([2, 4, 6, 7, 8, 9, 3]);
    expect(tiny.encode('unfixable').ids).toEqual([2, 1, 3]);
  });

  it('[AI-012] keeps [CLS] and [SEP] within the model’s 256 tokens', () => {
    const long = tokenizer.encode('word '.repeat(400));
    expect(long.ids).toHaveLength(256);
    expect(long.truncated).toBe(true);
    expect(long.ids[0]).toBe(101);
    expect(long.ids.at(-1)).toBe(102);
    expect(tokenizer.encode('', 256).ids).toEqual([101, 102]);
  });
});

describe('the bundled model (M1-078)', () => {
  const embedder = new LocalEmbedder();
  afterAll(() => embedder.close());

  it('[AI-012] makes unit vectors of 384 dimensions, offline and the same every time', async () => {
    expect(embedder.model).toBe(LOCAL_MODEL_ID);
    const [a, b] = await embedder.embed(['Login fails after a password reset', 'x']);
    expect(a).toHaveLength(LOCAL_DIMENSIONS);
    expect(dot(a as Float32Array, a as Float32Array)).toBeCloseTo(1, 4);
    const [again] = await embedder.embed(['Login fails after a password reset']);
    expect(Array.from(again as Float32Array)).toEqual(Array.from(a as Float32Array));
    // Whatever it is embedded with: one text per run, so neighbours change nothing.
    const [, alongside] = await embedder.embed([
      'x',
      'Login fails after a password reset',
      'a much longer text '.repeat(20),
    ]);
    expect(Array.from(alongside as Float32Array)).toEqual(Array.from(a as Float32Array));
    expect(b).toHaveLength(LOCAL_DIMENSIONS);
    expect(await embedder.embed([])).toEqual([]);
  });

  it('[AI-012] places paraphrases closer together than unrelated texts', async () => {
    const [login, signIn, chart, payment, card] = await embedder.embed([
      'login fails after password reset',
      'Cannot sign in following credential change',
      'Quarterly revenue chart shows the wrong colours',
      'Payment page times out at checkout',
      'Checkout hangs when paying by card',
    ]);
    const sim = (x?: Float32Array, y?: Float32Array) => dot(x as Float32Array, y as Float32Array);
    expect(sim(login, signIn)).toBeGreaterThan(sim(login, chart) + 0.2);
    expect(sim(payment, card)).toBeGreaterThan(sim(payment, login) + 0.2);
    expect(sim(payment, card)).toBeGreaterThan(sim(payment, chart));
  });

  it('[AI-012] embeds tickets fast enough for the background indexer', async () => {
    const texts = Array.from(
      { length: 64 },
      (_, i) =>
        `Ticket ${i}: the export to CSV drops the last column when a field holds a comma; seen on the release ${i % 5} build.`,
    );
    await embedder.embed(['warm up']);
    const started = performance.now();
    const vectors = await embedder.embed(texts);
    const msPerText = (performance.now() - started) / texts.length;
    expect(vectors).toHaveLength(64);
    // About 40 a second on one thread of a shared machine (ADR-106).
    expectWithinBudget(msPerText, 50, 'local embedding, ms per ticket-sized text');
    const one = performance.now();
    await embedder.embed(['duplicate check while typing a summary']);
    expectWithinBudget(performance.now() - one, 100, 'local embedding of one typed summary, ms');
  });
});

describe('an external embedding endpoint (M1-078)', () => {
  it('[AI-012] posts the texts, sends the key as a bearer token and normalises the answer', async () => {
    const seen: { auth: string | undefined; body: { model: string; input: string[] } }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; input: string[] };
        seen.push({ auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: body.input
              .map((text, index) => ({ index, embedding: [text.length, 0, 0] }))
              .reverse(),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const key = `k-${Math.random().toString(36).slice(2)}`;
    const embedder = new EndpointEmbedder({
      baseUrl: `http://127.0.0.1:${port}/v1/`,
      model: 'nomic-embed-text',
      apiKey: key,
      batchSize: 2,
    });
    try {
      expect(embedder.dimensions).toBe(0);
      const vectors = await embedder.embed(['ab', 'abcd', 'a']);
      expect(vectors.map((v) => Array.from(v))).toEqual([
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]);
      expect(embedder.dimensions).toBe(3);
      expect(embedder.model).toBe('endpoint:nomic-embed-text');
      expect(seen.map((s) => s.body.input)).toEqual([['ab', 'abcd'], ['a']]);
      expect(
        seen.every((s) => s.auth === `Bearer ${key}` && s.body.model === 'nomic-embed-text'),
      ).toBe(true);
    } finally {
      server.close();
    }
  });
});

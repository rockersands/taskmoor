import { randomBytes } from 'node:crypto';
import type { AdapterResponse } from '@taskmoor/ai';
import { FakeAdapter, fillInjection as fill, INJECTION_CASES } from '@taskmoor/ai/testing';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { SESSION_COOKIE } from '../../auth';
import type { AiConfigured } from '../service';
import { rerank } from './duplicates';

/**
 * The prompt-injection corpus of M1-118 through every AI feature of M1-079 (IAM-023; ADR-104,
 * "What M1-079 adds"; ADR-108), with a fake provider that obeys each injection: it answers with
 * the text the injection asks for, calls the tools it names and asks to write. The defences
 * hold without a model: the features offer no tools, so no call and no write can run; the
 * person's own rights decide what reaches the prompt (a hidden ticket never does); the
 * untrusted text stays inside one fence; and every answer is screened, so an image that would
 * carry data out is taken away and links to other sites are listed for the interface to name.
 */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.82.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const PEOPLE = ['admin', 'alice'] as const;
type Person = (typeof PEOPLE)[number];

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    list
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
      ?.split(';')[0] ?? ''
  );
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** What a model that fell for the case would answer, as text and tool calls. */
function obey(
  attempt: (typeof INJECTION_CASES)[number]['attempt'],
  values: Record<string, string>,
) {
  const text = attempt.kind === 'answer' ? fill(attempt.text, values) : 'Summary of the ticket.';
  const toolCalls =
    attempt.kind === 'write'
      ? [{ id: 'call_1', name: 'update_ticket', input: attempt.input }]
      : attempt.kind === 'call-tool'
        ? [{ id: 'call_1', name: attempt.tool, input: attempt.input }]
        : attempt.kind === 'read-hidden'
          ? [{ id: 'call_1', name: 'read_ticket', input: { key: values.hidden } }]
          : [];
  return { text, toolCalls };
}

/** Text that reads as a tag of one of `names`, look-alikes and spaces included. */
const tagLike = (names: readonly string[]) =>
  new RegExp(`[<＜﹤〈⟨]\\s*\\/?\\s*(${[...names, 'untrusted'].join('|')})\\b`, 'giu');
/** The fences a feature writes itself, of `names`. */
const realTags = (names: readonly string[]) =>
  new RegExp(`<(${names.join('|')})[ >]|<\\/(${names.join('|')})>`, 'g');

describe('Prompt injection through the AI features (M1-079)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let configured: AiConfigured | null = null;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const hiddenText = `bonus plan ${randomBytes(6).toString('hex')}`;
  let hiddenKey = '';
  let outcomeType = 0;

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const post = (who: Person, url: string, payload: unknown) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const ticketState = async () =>
    JSON.stringify(
      await database.db
        .selectFrom('ticket')
        .select(['id', 'summary', 'version', 'status_id', 'assignee_id'])
        .orderBy('id')
        .execute(),
    );

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      embedder: null,
      ai: { source: async () => configured, gateway: { retry: { maxRetries: 0 } } },
    });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const member = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    for (const key of ['INJ', 'HRX']) {
      const track = await post('admin', '/api/v1/tracks', { key, name: key, mode: 'shared' });
      expect(track.statusCode, track.body).toBe(201);
      if (key === 'INJ') {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: track.json().track.id,
            role_id: member.id,
            user_id: users.alice.id,
          })
          .execute();
      }
    }
    const types = (
      await as('admin', { method: 'GET', url: '/api/v1/tracks/INJ/ticket-types' })
    ).json().ticketTypes as { id: number; name: string }[];
    outcomeType = types.find((t) => t.name === 'Outcome')?.id as number;
    const hidden = await post('admin', '/api/v1/tickets?format=markdown', {
      track: 'HRX',
      summary: 'Compensation review',
      description: hiddenText,
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    hiddenKey = hidden.json().ticket.key;
  });

  afterAll(async () => {
    await app?.close();
  });

  for (const c of INJECTION_CASES) {
    it(`[IAM-023] ${c.goal}: ${c.id} holds through every feature`, async () => {
      const secret = `s${randomBytes(4).toString('hex')}`;
      const values = { hidden: hiddenKey, secret, sensitive: secret };
      const text = fill(c.text, values);
      // The carrier: the summary, a comment, or the description (fields and labels included).
      const created = await post('alice', '/api/v1/tickets?format=markdown', {
        track: 'INJ',
        ticketTypeId: outcomeType,
        summary: c.carrier === 'summary' ? text.slice(0, 200) : 'Login fails',
        description: c.carrier === 'summary' || c.carrier === 'comment' ? 'Blank page.' : text,
      });
      expect(created.statusCode, created.body).toBe(201);
      const key = created.json().ticket.key as string;
      if (c.carrier === 'comment') {
        const said = await post('alice', `/api/v1/tickets/${key}/comments`, { body: doc(text) });
        expect(said.statusCode, said.body).toBe(201);
      }
      const before = await ticketState();
      const { text: answer, toolCalls } = obey(c.attempt, values);
      const step = (body: string): Partial<AdapterResponse> => ({
        text: body,
        toolCalls,
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      });
      const asJson = (value: unknown) => step(JSON.stringify(value));

      // Summaries: streamed, fenced, screened.
      const summarising = new FakeAdapter([step(answer)]);
      configured = { adapter: summarising };
      const summary = await post('alice', `/api/v1/tickets/${key}/ai/summary`, {});
      expect(summary.statusCode, summary.body).toBe(200);
      const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(summary.body)?.[1] ?? '{}') as {
        text?: string;
        externalLinks?: string[];
      };

      // A structured answer that calls a tool nobody offered is invalid: refused, not applied.
      const structured = (res: { statusCode: number; body: string }) => {
        if (toolCalls.length > 0) {
          expect(res.statusCode, res.body).toBe(502);
          expect(JSON.parse(res.body)).toEqual({ error: 'ai_invalid_answer' });
        } else {
          expect(res.statusCode, res.body).toBe(200);
        }
        return res.statusCode === 200 ? (JSON.parse(res.body) as Record<string, unknown>) : {};
      };

      // Query from text: the question carries the injection.
      const querying = new FakeAdapter([
        asJson({ query: `key = ${hiddenKey}`, explanation: answer.slice(0, 1900) }),
      ]);
      configured = { adapter: querying };
      const query = structured(
        await post('alice', '/api/v1/ai/query', { text: text.slice(0, 2000) }),
      );

      // Drafts: the pasted text carries it.
      const drafting = new FakeAdapter([
        asJson({
          drafts: [{ summary: 'Draft', description: answer, type: '', priority: '', labels: [] }],
        }),
      ]);
      configured = { adapter: drafting };
      const drafts = structured(await post('alice', '/api/v1/ai/drafts', { track: 'INJ', text }));

      // Breakdown: the ticket carries it.
      const breaking = new FakeAdapter([
        asJson({ children: [{ summary: 'Child', description: answer, type: 'Feature' }] }),
      ]);
      configured = { adapter: breaking };
      const breakdown = structured(await post('alice', `/api/v1/tickets/${key}/ai/breakdown`, {}));

      // Duplicates: the new ticket's text and a candidate carry it.
      const ranking = new FakeAdapter([
        asJson({ ranked: [{ key, likely: true, reason: answer.slice(0, 290) }] }),
      ]);
      configured = { adapter: ranking };
      const gateway = await app.ai?.service.gateway(1);
      if (!gateway) throw new Error('AI is not configured');
      const ranked = await rerank(gateway, {
        text,
        candidates: [{ key, summary: text.slice(0, 200), excerpt: '' }],
        deadline: Date.now() + 2_000,
        userId: users.alice.id,
        trackId: null,
      });
      configured = null;

      const adapters = [summarising, querying, drafting, breaking, ranking];
      /** Each prompt's own element names. */
      const elements: Record<number, readonly string[]> = {
        0: ['ticket', 'comment', 'change'],
        1: ['question'],
        2: ['pasted'],
        3: ['ticket', 'child', 'pasted'],
        4: ['new', 'ticket'],
      };
      for (const adapter of adapters) {
        const sent = JSON.stringify(adapter.requests);
        // The person cannot see the hidden ticket, so no feature sends it.
        expect(sent).not.toContain(hiddenText);
        // No feature offers a tool: a call the model makes has nothing to run.
        expect(adapter.requests.every((r) => r.tools === undefined)).toBe(true);
      }
      // In every prompt, each tag-like text is one of the prompt's own fences: the injected
      // text opened and closed none (a neutralised one reads `&lt;`).
      for (const [i, adapter] of adapters.entries()) {
        const names = elements[i] ?? [];
        for (const request of adapter.requests) {
          const prompt = String(request.messages[0]?.content ?? '');
          const tags = prompt.match(tagLike(names))?.length ?? 0;
          expect(prompt.match(realTags(names))?.length ?? 0, prompt).toBe(tags);
        }
      }
      const prompt = String(summarising.requests[0]?.messages[0]?.content ?? '');
      expect(prompt.match(/<ticket key="|<\/ticket>/g)).toHaveLength(2);
      // Nothing was written: no ticket created or changed by any feature.
      expect(await ticketState()).toBe(before);

      // Screened answers: no image that would load from another site, anywhere.
      const shown = [
        done.text ?? '',
        String(query.explanation ?? ''),
        String((drafts.drafts as { description: string }[] | undefined)?.[0]?.description ?? ''),
        String(
          (breakdown.children as { description: string }[] | undefined)?.[0]?.description ?? '',
        ),
        ranked?.reasons.get(key)?.reason ?? '',
      ];
      for (const out of shown) {
        expect(out).not.toMatch(/!\[[^\]]*\]\(\s*https?:\/\//);
        expect(out).not.toMatch(/<img\b/i);
      }
      if (c.goal === 'exfiltrate-link' && /https?:\/\//.test(answer)) {
        expect(done.externalLinks?.length ?? 0).toBeGreaterThan(0);
      }
    });
  }
});

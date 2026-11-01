// Run inside the offline Taskmoor container by test-offline.sh (M1-078, AI-012 (1)): finishes
// first-run setup with the printed token, makes a track and three tickets, then waits for the
// worker to embed them with the bundled model and asks for the tickets similar to the first.
// With no AI key and no route out, the paraphrase must come back first.
//   docker compose exec -T taskmoor node --input-type=module - <token> < check-embeddings.mjs
import { randomBytes } from 'node:crypto';

const base = 'http://127.0.0.1:8080';
const token = process.argv[2];
if (!token) throw new Error('usage: check-embeddings.mjs <setup token>');
// Made for this run only: the instance is thrown away with the test.
const password = randomBytes(18).toString('base64url');
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  const set = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter((c) => /^[^=]+=.+/.test(c));
  if (set.length > 0) cookie = set.join('; ');
  return text ? JSON.parse(text) : null;
}

await call('POST', '/api/v1/setup', {
  token,
  instanceName: 'Air-gap test',
  admin: { name: 'Admin', email: 'admin@example.com', password },
});
await call('POST', '/api/v1/session', { email: 'admin@example.com', password });
await call('POST', '/api/v1/tracks', { key: 'GAP', name: 'Offline', mode: 'shared' });
const made = [];
for (const summary of [
  'Login fails after password reset',
  'Quarterly revenue chart has the wrong colours',
  'Cannot sign in following credential change',
]) {
  made.push((await call('POST', '/api/v1/tickets', { track: 'GAP', summary })).ticket.key);
}
console.log(`tickets ${made.join(', ')} made`);

const started = Date.now();
for (;;) {
  const answer = await call('GET', `/api/v1/tickets/${made[0]}/similar?limit=2`);
  if (answer.similar.length === 2) {
    const [first] = answer.similar;
    console.log(
      `similar to ${made[0]}: ${answer.similar.map((s) => `${s.ticket.key} (${s.score})`).join(', ')}; model ${answer.model}; ${Date.now() - started} ms after the tickets`,
    );
    if (first.ticket.key !== made[2]) throw new Error(`expected ${made[2]} first`);
    break;
  }
  if (Date.now() - started > 120_000) throw new Error('no similar tickets after two minutes');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const typed = await call('POST', '/api/v1/tickets/similar', {
  text: 'the revenue chart uses odd colours',
  track: 'GAP',
  limit: 1,
});
if (typed.similar[0]?.ticket.key !== made[1])
  throw new Error('the typed text found the wrong ticket');
console.log(`duplicate suggestion for a typed text: ${typed.similar[0].ticket.key}`);

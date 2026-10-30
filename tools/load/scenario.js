// The load-test scenario (M1-104; NFR-003; ADR-082), run by `pnpm load` with k6. Each virtual
// user is one person with an API token: it ramps up over RAMP, holds USERS people for HOLD,
// and each person repeats a step and a rest of 5 to 15 seconds. Steps, by share: open a ticket
// 40%, search 15%, read the board 10%, read a ticket's history 10%, edit a summary 12%, comment
// 10%, create a ticket 3%: a quarter of requests write, as NFR-003 asks.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const F = JSON.parse(open(__ENV.FIXTURES));
const USERS = Number(__ENV.USERS || 50);

export const options = {
  scenarios: {
    people: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '30s', target: USERS },
        { duration: __ENV.HOLD || '2m', target: USERS },
      ],
      gracefulRampDown: '10s',
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max', 'count'],
  // k6 checks nothing itself: the report compares the numbers with the targets.
  thresholds: {},
};

const trends = {
  open_ticket: new Trend('open_ticket', true),
  search: new Trend('search', true),
  board: new Trend('board', true),
  history: new Trend('history', true),
  edit: new Trend('edit', true),
  comment: new Trend('comment', true),
  create: new Trend('create', true),
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function call(action, method, path, body) {
  const token = F.tokens[(__VU - 1) % F.tokens.length];
  const params = {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    tags: { action },
  };
  const url = `${F.baseUrl}${path}`;
  const res =
    method === 'GET'
      ? http.get(url, params)
      : http.request(method, url, body === undefined ? null : JSON.stringify(body), params);
  trends[action].add(res.timings.duration);
  check(res, { [`${action} ok`]: (r) => r.status >= 200 && r.status < 300 });
  return res;
}

const paragraph = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

export default function () {
  const r = Math.random();
  const key = pick(F.keys);
  if (r < 0.4) {
    call('open_ticket', 'GET', `/api/v1/tickets/${key}`);
  } else if (r < 0.55) {
    const q = `track = ${pick(F.tracks)} AND status = "${pick(F.statuses)}" ORDER BY updated DESC`;
    call('search', 'GET', `/api/v1/search?q=${encodeURIComponent(q)}&limit=50`);
  } else if (r < 0.65) {
    call('board', 'GET', `/api/v1/boards/${F.board}/data`);
  } else if (r < 0.75) {
    call('history', 'GET', `/api/v1/tickets/${key}/history?limit=50`);
  } else if (r < 0.87) {
    call('edit', 'PATCH', `/api/v1/tickets/${key}`, {
      summary: `Load edit ${__VU}-${__ITER}`,
    });
  } else if (r < 0.97) {
    call('comment', 'POST', `/api/v1/tickets/${key}/comments`, {
      body: paragraph(`Load comment ${__VU}-${__ITER}`),
    });
  } else {
    call('create', 'POST', '/api/v1/tickets', {
      track: pick(F.tracks),
      summary: `Load ticket ${__VU}-${__ITER}`,
    });
  }
  sleep(5 + Math.random() * 10);
}

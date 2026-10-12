// In-cluster load for the rolling-upgrade test (M1-099): several clients call the app through
// its Service for LOAD_SECONDS and report every request that did not succeed. Runs in the
// Taskmoor image itself (Node 22), so the test needs no other image.
const target = process.env.TARGET ?? 'http://taskmoor';
const seconds = Number(process.env.LOAD_SECONDS ?? 120);
const clients = Number(process.env.CLIENTS ?? 8);
const end = Date.now() + seconds * 1000;
const failures = [];
let ok = 0;
const versions = new Set();

async function client(id) {
  while (Date.now() < end) {
    const path = id % 2 === 0 ? '/api/v1/setup' : '/health';
    try {
      const res = await fetch(`${target}${path}`);
      const body = await res.text();
      if (res.ok) {
        ok++;
        if (path === '/health') versions.add(JSON.parse(body).version);
      } else failures.push(`${new Date().toISOString()} ${path} ${res.status}`);
    } catch (error) {
      failures.push(`${new Date().toISOString()} ${path} ${error.cause?.code ?? error.message}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

await Promise.all(Array.from({ length: clients }, (_, i) => client(i)));
console.log(
  JSON.stringify({
    ok,
    failed: failures.length,
    versions: [...versions],
    failures: failures.slice(0, 20),
  }),
);

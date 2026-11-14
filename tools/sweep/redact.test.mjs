import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { demoOutput } from './demo.mjs';
import { firstLine, pngSize, redact } from './redact.mjs';
import {
  adminLinkFrom,
  adminLinkIn,
  ensureSignedIn,
  makePassword,
  signInFailure,
} from './session.mjs';

// Values shaped like real secrets, made at run time so no secret scanner mistakes this file for
// one holding them.
const SECRET = `Zq${'x7'.repeat(16)}Kp`;
const API_TOKEN = `tmk_${'A1b2'.repeat(11)}c3`;
const OAUTH_TOKEN = `tma_${'q-W_'.repeat(10)}abc`;
const LINK = `http://localhost:8090/#/password?token=${SECRET}`;

/** The demo's output (apps/server/src/demo/cli.ts), with made-up people and links. */
const DEMO_OUTPUT = [
  'Taskmoor demo: building the frontend...',
  'One-time links to set a password:',
  '  Sam Admin <sam@example.com> (site administrator)',
  `    ${LINK}`,
  '  Ada Person <ada@example.com>',
  `    http://localhost:8090/#/password?token=other${SECRET}`,
  'Taskmoor answers on http://localhost:8090',
].join('\n');

describe('redact', () => {
  it.each([
    [`GET ${LINK}`, 'GET http://localhost:8090/#/password?token=...'],
    [`#/oauth/consent?request=${SECRET}&x=1`, '#/oauth/consent?request=...&x=1'],
    [`callback?code=${SECRET}&state=${SECRET}`, 'callback?code=...&state=...'],
    [`{"password":"${SECRET}","name":"Sam"}`, '{"password":"...","name":"Sam"}'],
    [`{"token": "${SECRET}"}`, '{"token":"..."}'],
    [`{"accessToken":"${SECRET}"}`, '{"accessToken":"..."}'],
    [`Authorization: Bearer ${SECRET}`, 'Authorization: Bearer ...'],
    [`Cookie: taskmoor_session=${SECRET}; other=1`, 'Cookie: ...'],
    [`postgres://taskmoor:${SECRET}@db:5432/x`, 'postgres://taskmoor:...@db:5432/x'],
    [`made ${API_TOKEN} and ${OAUTH_TOKEN}`, 'made tmk_... and tma_...'],
    [`filled sweep-${SECRET}`, 'filled sweep-...'],
  ])('[NFR-008] hides the secret in %#', (text, shown) => {
    expect(redact(text)).toBe(shown);
    expect(redact(text)).not.toContain(SECRET.slice(2, 20));
  });

  it('[NFR-008] leaves addresses and words that hold no secret as they are', () => {
    for (const text of [
      '#/tracks/MOB/board',
      '#/search?q=track%20%3D%20MOB&locale=es',
      '404 GET http://localhost:8090/api/v1/tracks/MOB/fields',
      'Keep the token in the safe store of the phone',
      '#/admin/layouts?set=12',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it('[NFR-008] cuts long text after redacting it, so a cut never leaves half a secret', () => {
    const text = `${'a'.repeat(290)} token=${SECRET}`;
    expect(redact(text)).toHaveLength(300);
    expect(redact(text)).not.toContain(SECRET.slice(0, 6));
    expect(redact('abcdef', 3)).toBe('abc');
    expect(redact(undefined)).toBe('');
  });

  it("[NFR-008] keeps only an error's first line, redacted", () => {
    const error = new Error(
      `page.goto: net::ERR_CONNECTION_REFUSED at ${LINK}\nCall log:\n  - navigating to "${LINK}"`,
    );
    expect(firstLine(error)).toBe(
      'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8090/#/password?token=...',
    );
    expect(firstLine(`plain ${API_TOKEN}`)).toBe('plain tmk_...');
  });
});

describe('the session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-session-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("[NFR-008] reads the site administrator's link, the last one the demo printed", () => {
    expect(adminLinkIn(DEMO_OUTPUT)).toBe(LINK);
    const restarted = `${DEMO_OUTPUT}\n${DEMO_OUTPUT.replace(SECRET, `new${SECRET}`)}`;
    expect(adminLinkIn(restarted)).toBe(`http://localhost:8090/#/password?token=new${SECRET}`);
    expect(adminLinkIn(DEMO_OUTPUT.replace(' (site administrator)', ''))).toBeNull();
    expect(adminLinkIn('')).toBeNull();
  });

  it("[NFR-008] takes a link the sweep's own log redacted as no link", () => {
    const logged = [];
    const output = demoOutput((text) => logged.push(text));
    output.push(DEMO_OUTPUT);
    output.end();
    const redactedLog = logged.join('');
    expect(redactedLog).toContain('http://localhost:8090/#/password?token=...');
    expect(adminLinkIn(redactedLog)).toBeNull();
    // A demo started by hand after the sweep's run writes a real link after the redacted ones.
    expect(adminLinkIn(`${redactedLog}\n${DEMO_OUTPUT}`)).toBe(LINK);
    // The last demo's link is redacted: an earlier real one belongs to a demo that is gone.
    expect(adminLinkIn(`${DEMO_OUTPUT}\n${redactedLog}`)).toBeNull();
  });

  it('[NFR-008] reads the link from a log file, and nothing from one that is not there', () => {
    const file = join(dir, 'demo.log');
    writeFileSync(file, DEMO_OUTPUT);
    expect(adminLinkFrom(file)).toBe(LINK);
    expect(adminLinkFrom(join(dir, 'missing.log'))).toBeNull();
    expect(adminLinkFrom(undefined)).toBeNull();
    writeFileSync(file, redact(DEMO_OUTPUT, 2000));
    expect(adminLinkFrom(file)).toBeNull();
  });

  it("[NFR-008] says there is no administrator's link when the log holds only redacted ones", async () => {
    const logFile = join(dir, 'redacted.log');
    writeFileSync(logFile, redact(DEMO_OUTPUT, 2000));
    // No saved state: the browser is never asked to open anything.
    const browser = {
      newContext: () => {
        throw new Error('opened a page');
      },
    };
    await expect(
      ensureSignedIn(browser, {
        url: 'http://localhost:8090',
        link: null,
        logFile,
        stateFile: join(dir, 'no-state.json'),
      }),
    ).rejects.toThrow(/^No saved session and no administrator's link: run with --demo/);
  });

  it('[NFR-008] makes a new long random password each time', () => {
    const one = makePassword();
    expect(one).toMatch(/^sweep-[A-Za-z0-9_-]{32}$/);
    expect(makePassword()).not.toBe(one);
  });

  it('[NFR-008] says what failed in signing in, never the link or the password', () => {
    const password = makePassword();
    const failure = signInFailure(
      new Error(`locator.fill: could not fill "${password}" on ${LINK}\nCall log:\n${LINK}`),
    );
    expect(failure.message).toMatch(/^Signing in with the demo's link failed: locator\.fill/);
    expect(failure.message).not.toContain(SECRET);
    expect(failure.message).not.toContain(password.slice(6));
  });
});

describe("the demo's output", () => {
  it('[NFR-008] keeps the link in memory and logs every line with the links redacted', () => {
    const logged = [];
    const output = demoOutput((text) => logged.push(text));
    // Pieces as a pipe delivers them, splitting lines and the link itself.
    const cuts = [5, 47, 90, 110, 140, DEMO_OUTPUT.length];
    let from = 0;
    for (const to of cuts) {
      output.push(Buffer.from(DEMO_OUTPUT.slice(from, to)));
      from = to;
    }
    output.end();
    expect(output.link()).toBe(LINK);
    const log = logged.join('');
    expect(log).not.toContain(SECRET);
    expect(log).toContain('(site administrator)');
    expect(log).toContain('http://localhost:8090/#/password?token=...');
    expect(log.split('\n').filter(Boolean)).toHaveLength(DEMO_OUTPUT.split('\n').length);
  });

  it('[NFR-008] keeps no link when the administrator has none', () => {
    const output = demoOutput(() => {});
    output.push('Taskmoor answers on http://localhost:8090\n');
    output.end();
    expect(output.link()).toBeNull();
  });

  it('[NFR-008] prints and writes only through redact, in every file of the tool', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const files = [
      'routes.mjs',
      'demo.mjs',
      'session.mjs',
      'seed.mjs',
      'probe.mjs',
      'plan.mjs',
      'states.mjs',
    ];
    const writes = [];
    for (const file of files) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text).not.toMatch(/\bconsole\.(log|info|warn|error)\(/);
      for (const m of text.matchAll(/process\.(stdout|stderr)\.write\(([^\n]*)/g)) {
        writes.push(`${file}: ${m[2]}`);
      }
    }
    // One line printer, which redacts; and the usage line, made by parseSweepArgs.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^routes\.mjs: .*error\.message/);
    expect(writes[1]).toMatch(/^routes\.mjs: .*redact\(line, 2000\)/);
  });
});

describe('pngSize', () => {
  const header = (width, height) => {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };

  it('[NFR-007] reads the width and height of a picture from its header', () => {
    expect(pngSize(header(750, 1624))).toEqual({ width: 750, height: 1624 });
    expect(pngSize(new Uint8Array(header(1280, 9000)))).toEqual({ width: 1280, height: 9000 });
  });

  it('[NFR-007] says nothing for what is not a PNG', () => {
    expect(pngSize(Buffer.from('not a picture at all, just words'))).toBeNull();
    expect(pngSize(header(1, 1).subarray(0, 20))).toBeNull();
    const wrongChunk = header(10, 10);
    wrongChunk.write('IDAT', 12, 'latin1');
    expect(pngSize(wrongChunk)).toBeNull();
    expect(pngSize(null)).toBeNull();
  });
});

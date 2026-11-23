import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type MessageId, messagesEn } from '../i18n/messages.en';
import { messagesEs } from '../i18n/messages.es';
import { typeName } from '../shell/seededNames';

/** The server's source, from the repository root or from the app (as the SSO tests read it). */
const serverSource = (file: string) => {
  const path = [`apps/server/src/${file}`, `../server/src/${file}`]
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return readFileSync(path ?? file, 'utf8');
};

/**
 * The release notes' Markdown is written on the server, in the page's language (T-283); its
 * section headings must read as the page's own do, which come from this catalogue.
 */
describe('the release notes in Spanish (T-283)', () => {
  it('[NFR-006] [CORE-016] heads the sections with the seeded types as the Spanish page names them', () => {
    const source = serverSource('releases/notes-text.ts');
    const es = source.indexOf('  es: {');
    const from = source.indexOf('types: {', es);
    expect(es).toBeGreaterThan(0);
    expect(from).toBeGreaterThan(es);
    const block = source.slice(from, source.indexOf('},', from));
    const server = [...block.matchAll(/^\s*'?([A-Za-z-]+)'?: '([^']+)',$/gm)].map(
      (m) => [m[1], m[2]] as [string, string],
    );
    // Every seeded type the page translates, and nothing else.
    const seeded = (Object.keys(messagesEn) as MessageId[])
      .filter((id) => id.startsWith('ticketType.name.'))
      .map((id) => messagesEn[id]);
    expect(server.map(([stored]) => stored).sort()).toEqual([...seeded].sort());
    const spanish = (id: MessageId) => messagesEs[id];
    for (const [stored, written] of server) expect(typeName(spanish, stored), stored).toBe(written);
  });
});

import { describe, expect, it } from 'vitest';
import { messagesEn } from './messages.en';
import { messagesEs } from './messages.es';

/** Text people read: placeholders and other products' names are not ours to rename. */
const shown = (text: string) => text.replace(/\{[a-zA-Z]+\}/g, '').replace(/Google Workspace/g, '');

const saying = (catalogue: Record<string, string>, word: RegExp) =>
  Object.entries(catalogue)
    .filter(([, text]) => word.test(shown(String(text))))
    .map(([id]) => id);

describe('the product vocabulary (docs/specs/00-terminology.md)', () => {
  it('[NFR-006] says "site" for the whole installation, never "workspace" or "instance"', () => {
    expect(saying(messagesEn, /\b(workspaces?|instances?)\b/i)).toEqual([]);
    expect(saying(messagesEs, /\b(espacios? de trabajo|instancias?)\b/i)).toEqual([]);
    expect(messagesEn['admin.system.instance']).toBe('Site');
    expect(messagesEs['admin.system.instance']).toBe('Sitio');
  });

  it('[PLN-001] names the section Plans and one of them a plan, never Multi-track', () => {
    expect(messagesEn['nav.plans']).toBe('Plans');
    expect(messagesEs['nav.plans']).toBe('Planes');
    expect(saying(messagesEn, /multi-?track|roadmap/i)).toEqual([]);
    expect(saying(messagesEs, /multi-?track|hoja de ruta/i)).toEqual([]);
  });

  it('[NFR-006] keeps no text that nothing shows: the ticket page has no purpose line', () => {
    expect('purpose.ticket' in messagesEn).toBe(false);
    expect('purpose.ticket' in messagesEs).toBe(false);
  });
});

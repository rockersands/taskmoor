import { describe, expect, it } from 'vitest';
import { commentText } from './comments';

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('a comment as plain text (email, excerpts, AI context)', () => {
  it('[NTF-014] a collapsible section reads as its title, then its text', () => {
    const body = {
      type: 'doc',
      content: [
        paragraph('It fails again.'),
        {
          type: 'expand',
          attrs: { title: 'Steps to reproduce' },
          content: [paragraph('Click save twice'), paragraph('Reload the page')],
        },
        paragraph('Any ideas?'),
      ],
    };
    expect(commentText(body)).toBe(
      'It fails again.\nSteps to reproduce\nClick save twice\nReload the page\nAny ideas?',
    );
  });

  it('[NTF-014] a section without a title reads as its text alone', () => {
    const body = {
      type: 'doc',
      content: [{ type: 'expand', attrs: { title: '' }, content: [paragraph('Only this')] }],
    };
    expect(commentText(body)).toBe('Only this');
  });

  it('[NTF-014] a section in a section keeps both titles, outer first', () => {
    const body = {
      type: 'doc',
      content: [
        {
          type: 'expand',
          attrs: { title: 'Logs' },
          content: [{ type: 'expand', attrs: { title: 'Tuesday' }, content: [paragraph('500')] }],
        },
      ],
    };
    expect(commentText(body)).toBe('Logs\nTuesday\n500');
  });

  it("[NTF-014] the slash menu's inline blocks read as the other text formats write them", () => {
    const body = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Due ' },
            { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 10, 20)) } },
            { type: 'text', text: ', now ' },
            { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } },
            { type: 'text', text: ' ' },
            { type: 'emoji', attrs: { shortName: ':fire:', text: '🔥' } },
            { type: 'emoji', attrs: { shortName: ':custom:', text: null } },
            { type: 'text', text: ', see ' },
            { type: 'ticketRef', attrs: { key: 'PAY-42' } },
            { type: 'text', text: ' and ' },
            {
              type: 'unknownInline',
              attrs: { adf: { type: 'inlineCard', attrs: { url: 'https://example.test/x' } } },
            },
          ],
        },
        {
          type: 'columnLayout',
          content: [
            { type: 'column', attrs: { width: 40 }, content: [paragraph('Left')] },
            { type: 'column', attrs: { width: 60 }, content: [paragraph('Right')] },
          ],
        },
        {
          type: 'attachmentRef',
          attrs: { name: 'shot.png', image: true, digest: '3f2a9c0d1e4b5a67' },
        },
      ],
    };
    expect(commentText(body)).toBe(
      'Due 2026-11-20, now [BLOCKED] 🔥:custom:, see PAY-42 and https://example.test/x\nLeft\nRight\nshot.png',
    );
  });

  it('[NTF-001] mentions read as names, line breaks as lines, and a long text is cut', () => {
    const body = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { id: '7', label: 'Ana' } },
            { type: 'hardBreak' },
            { type: 'text', text: 'today' },
          ],
        },
        paragraph('x'.repeat(50)),
      ],
    };
    expect(commentText(body)).toBe(`Ask @Ana\ntoday\n${'x'.repeat(50)}`);
    expect(commentText(body, 10)).toBe('Ask @Ana\n…');
    expect(commentText({ type: 'nothing we know' })).toBe('');
  });
});

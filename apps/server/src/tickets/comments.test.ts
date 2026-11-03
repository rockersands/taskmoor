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

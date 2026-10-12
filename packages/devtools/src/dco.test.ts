import { describe, expect, it } from 'vitest';
import { type CommitInfo, checkDco, signOffs } from './dco';

const commit = (message: string, overrides: Partial<CommitInfo> = {}): CommitInfo => ({
  sha: 'abcdef1234567890',
  authorName: 'Rockersands',
  authorEmail: '42122514+rockersands@users.noreply.github.com',
  parents: 1,
  message,
  ...overrides,
});

describe('checkDco', () => {
  it('accepts a commit signed off by its author, among other trailers', () => {
    const message = [
      'Add a thing',
      '',
      'Body.',
      '',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Signed-off-by: Rockersands <42122514+rockersands@users.noreply.github.com>',
    ].join('\n');
    expect(checkDco([commit(message)])).toEqual([]);
  });

  it('rejects a missing sign-off and names the trailer to add', () => {
    expect(checkDco([commit('Add a thing\n\nNo trailer.')])).toEqual([
      'abcdef1 "Add a thing" needs "Signed-off-by: Rockersands <42122514+rockersands@users.noreply.github.com>"',
    ]);
  });

  it('rejects a sign-off by someone other than the author', () => {
    const problems = checkDco([commit('Fix\n\nSigned-off-by: Someone <someone@example.com>')]);
    expect(problems[0]).toMatch(/found: Someone <someone@example.com>/);
  });

  it('skips merge commits', () => {
    expect(checkDco([commit('Merge pull request #1', { parents: 2 })])).toEqual([]);
  });
});

describe('signOffs', () => {
  it('reads every Signed-off-by trailer, case-insensitively', () => {
    expect(signOffs('x\n\nsigned-off-by: A <a@x>\nSigned-off-by: B <b@x>\n')).toEqual([
      'A <a@x>',
      'B <b@x>',
    ]);
  });
});

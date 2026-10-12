import { execFileSync } from 'node:child_process';

/**
 * Developer Certificate of Origin (ADR-002): every non-merge commit carries a
 * `Signed-off-by: Name <email>` trailer that matches its author.
 */
export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  parents: number;
  message: string;
}

export function signOffs(message: string): string[] {
  return [...message.matchAll(/^Signed-off-by:\s*(.+?)\s*$/gim)].map((m) => m[1] ?? '');
}

/** Returns one problem per commit that lacks its author's sign-off. Merge commits are skipped. */
export function checkDco(commits: readonly CommitInfo[]): string[] {
  const problems: string[] = [];
  for (const c of commits) {
    if (c.parents > 1) continue;
    const expected = `${c.authorName} <${c.authorEmail}>`;
    const found = signOffs(c.message);
    if (!found.some((s) => s.toLowerCase() === expected.toLowerCase())) {
      const subject = c.message.split('\n')[0] ?? '';
      problems.push(
        `${c.sha.slice(0, 7)} "${subject}" needs "Signed-off-by: ${expected}"` +
          (found.length ? ` (found: ${found.join('; ')})` : ''),
      );
    }
  }
  return problems;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Reads commits for a git revision range, for example `origin/main..HEAD`. */
export function readCommits(range: string, cwd = process.cwd()): CommitInfo[] {
  const out = execFileSync(
    'git',
    ['log', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%P${FIELD}%B${RECORD}`, range],
    { cwd, encoding: 'utf8' },
  );
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha = '', authorName = '', authorEmail = '', parents = '', message = ''] =
        record.split(FIELD);
      return {
        sha,
        authorName,
        authorEmail,
        parents: parents.trim() ? parents.trim().split(/\s+/).length : 0,
        message: message.trim(),
      };
    });
}

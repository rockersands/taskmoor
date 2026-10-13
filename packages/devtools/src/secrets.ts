import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface SecretRule {
  id: string;
  pattern: RegExp;
  /** Skip test files, where placeholder credentials are expected. */
  skipTests?: boolean;
}

/** Credential formats that must never be committed. Kept specific to avoid noise. */
export const SECRET_RULES: SecretRule[] = [
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-live-key', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
  { id: 'private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  // Taskmoor's own API tokens (ADR-034): prefix, 40 random and 6 checksum characters.
  { id: 'taskmoor-api-token', pattern: /\btmk_[0-9A-Za-z]{46}\b/ },
  {
    id: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s@/'"`]{8,}@[^\s'"`]+/,
    skipTests: true,
  },
];

/** Put this on a line to accept it after review. */
export const ALLOW_MARKER = 'secret-scan: allow';

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_BYTES = 1_000_000;

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

export function scanText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const isTest = TEST_FILE.test(file);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    // A reviewed, intentionally public value (for example a CI-only throwaway password).
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of SECRET_RULES) {
      if (rule.skipTests && isTest) continue;
      if (rule.pattern.test(line)) findings.push({ file, line: index + 1, rule: rule.id });
    }
  });
  return findings;
}

/** Files git would commit: tracked plus untracked ones that are not ignored. */
export function candidateFiles(root: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return [...new Set(out.split('\0').filter(Boolean))];
}

export function scanRepository(root: string, files = candidateFiles(root)): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const path = join(root, file);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > MAX_BYTES || file.endsWith('pnpm-lock.yaml')) continue;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue; // binary
    findings.push(...scanText(file, buffer.toString('utf8')));
  }
  return findings;
}

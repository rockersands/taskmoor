import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, cspMetaElement } from './csp';

const directive = (policy: string, name: string) =>
  policy
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? [];

describe('the content security policy (M1-107)', () => {
  it('[IAM-025] runs scripts and stylesheets from the app’s own origin only', () => {
    const policy = contentSecurityPolicy();
    expect(directive(policy, 'default-src')).toEqual(["'self'"]);
    expect(directive(policy, 'script-src')).toEqual(["'self'"]);
    expect(directive(policy, 'style-src-elem')).toEqual(["'self'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'self'"]);
    expect(directive(policy, 'form-action')).toEqual(["'self'"]);
    expect(policy).not.toContain('unsafe-eval');
    // Framing is refused in the header form only: meta elements cannot say it.
    expect(directive(policy, 'frame-ancestors')).toEqual([]);
    expect(directive(contentSecurityPolicy({ header: true }), 'frame-ancestors')).toEqual([
      "'none'",
    ]);
  });

  it('[IAM-025] lets the app reach its backend on another origin, over HTTP and WebSockets', () => {
    const policy = contentSecurityPolicy({
      apiUrl: 'https://api.example.net/',
      mediaOrigins: ['https://files.example.net'],
    });
    expect(directive(policy, 'connect-src')).toEqual([
      "'self'",
      'https://api.example.net',
      'wss://api.example.net',
    ]);
    expect(directive(policy, 'img-src')).toContain('https://files.example.net');
    expect(directive(policy, 'frame-src')).toContain('https://api.example.net');
    expect(directive(policy, 'script-src')).toEqual(["'self'"]);
  });

  it('[IAM-025] allows inline blocks only by their hashes', () => {
    const policy = contentSecurityPolicy({
      scriptHashes: ["'sha256-abc='"],
      styleHashes: ["'sha256-def='"],
    });
    expect(directive(policy, 'script-src')).toEqual(["'self'", "'sha256-abc='"]);
    expect(directive(policy, 'style-src-elem')).toEqual(["'self'", "'sha256-def='"]);
    expect(cspMetaElement(policy)).toMatch(
      /^<meta http-equiv="Content-Security-Policy" content="[^"]+" \/>$/,
    );
  });
});

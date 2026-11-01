import { randomBytes } from 'node:crypto';
import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { pepperFromSecret, pepperRing } from './password';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  openSecret,
  otpauthUri,
  sealSecret,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp';

describe('one-time passwords (RFC 6238)', () => {
  it('[IAM-001] matches the RFC 6238 test vectors for SHA-1', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpCode(secret, Math.floor(seconds / 30), 8)).toBe(code);
    }
  });

  it('round-trips base32', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 40 }), (bytes) => {
        expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
      }),
    );
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('[IAM-001] accepts the current code and one step of drift, and each step only once', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = new Date('2026-10-12T12:00:10Z');
    const step = totpStep(now);
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    // ASVS 2.8.4: a code used once is refused for the rest of its validity.
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, now)).toBe(step);
  });

  it('builds the provisioning URI authenticator apps read', () => {
    expect(otpauthUri('Taskmoor', 'ana@example.com', 'ABC')).toBe(
      'otpauth://totp/Taskmoor%3Aana%40example.com?secret=ABC&issuer=Taskmoor&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('[IAM-001] makes ten distinct recovery codes that compare without case or dashes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(normaliseRecoveryCode(' abcde-fghij ')).toBe('ABCDEFGHIJ');
  });

  it('[IAM-001] refuses a sealed secret whose tag was cut short (M1-118)', () => {
    const key = pepperFromSecret('a pepper for sealing, long enough to use');
    const plain = randomBytes(10).toString('hex');
    const parts = sealSecret(plain, key).split(':');
    const tag = Buffer.from(parts[4] as string, 'base64url');
    for (const length of [4, 8, 12]) {
      parts[4] = tag.subarray(0, length).toString('base64url');
      expect(openSecret(parts.join(':'), pepperRing(key)), `${length} bytes`).toBeNull();
    }
  });

  it('[IAM-001] seals secrets under the pepper and opens them with the right key only', () => {
    const key = pepperFromSecret('a pepper for sealing, long enough to use');
    const other = pepperFromSecret('another pepper, also long enough to use!');
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    expect(sealed.startsWith(`enc1:${key.id}:`)).toBe(true);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, pepperRing(key))).toBe('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, pepperRing(other))).toBeNull();
    // A changed tag is refused. Its first character carries six whole bits of the tag, so
    // changing it always changes the tag (the last ones carry padding bits that decode away).
    const parts = sealed.split(':');
    const tag = parts[4] as string;
    parts[4] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    expect(openSecret(parts.join(':'), pepperRing(key))).toBeNull();
    expect(openSecret(sealSecret('dev', undefined), undefined)).toBe('dev');
  });
});

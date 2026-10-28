import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * Self-signed X.509 certificates for tests (M1-081): node:crypto reads certificates but cannot
 * make one, so this writes the few DER structures a certificate needs. RSA keys, SHA-256.
 */
function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));

function integer(bytes: Buffer): Buffer {
  // Positive: a leading zero when the high bit is set.
  return tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const out = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(at: Date): Buffer {
  const text = at.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(0x17, Buffer.from(`${text}Z`));
}

const name = (commonName: string) =>
  sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));

const SHA256_WITH_RSA = sequence(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));

export interface TestCertificate {
  /** The certificate, PEM. */
  certificate: string;
  privateKey: KeyObject;
  /** The private key, PKCS#8 PEM (as xml-crypto takes it). */
  privateKeyPem: string;
}

export function selfSignedCertificate(
  commonName: string,
  options: { days?: number; notBefore?: Date } = {},
): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const from = options.notBefore ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const until = new Date(from.getTime() + (options.days ?? 365) * 24 * 60 * 60 * 1000);
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // version 3
    integer(randomBytes(8)),
    SHA256_WITH_RSA,
    name(commonName),
    sequence(utcTime(from), utcTime(until)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(
    tbs,
    SHA256_WITH_RSA,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`,
    privateKey,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

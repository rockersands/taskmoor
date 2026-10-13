import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests (M1-084): makes the registration and assertion
 * responses a browser would send, with an ES256 key, "none" attestation and a counter. Only
 * what the server checks; not a full CTAP implementation.
 */
type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const write = (v: Cbor) => {
    if (typeof v === 'number') {
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === 'string') {
      const bytes = Buffer.from(v, 'utf8');
      out.push(...head(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v);
    } else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      for (const item of v) write(item);
    } else {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        write(k);
        write(item);
      }
    }
  };
  write(value);
  return Uint8Array.from(out);
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const b64url = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');
const uint32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

interface Key {
  privateKey: KeyObject;
  counter: number;
}

export class SoftAuthenticator {
  private readonly keys = new Map<string, Key>();

  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {}

  /** A registration response for `navigator.credentials.create()` with these options. */
  register(options: { challenge: string }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const credentialId = randomBytes(16);
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x01 | 0x04 | 0x40]),
      uint32(0),
      Buffer.alloc(16),
      idLength,
      credentialId,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientData = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    const id = b64url(credentialId);
    this.keys.set(id, { privateKey, counter: 0 });
    return {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'cross-platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ['usb'],
      },
    };
  }

  /** An assertion response for `navigator.credentials.get()` with these options. */
  authenticate(options: { challenge: string }, credentialId?: string) {
    const id = credentialId ?? [...this.keys.keys()][0];
    const key = id ? this.keys.get(id) : undefined;
    if (!id || !key) throw new Error('no such credential');
    key.counter += 1;
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x01 | 0x04]),
      uint32(key.counter),
    ]);
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), key.privateKey);
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
    };
  }
}

/**
 * Proof that a frontend reached the backend it was built for (M1-106; API-017; ADR-070). Each
 * instance has an id and an Ed25519 key pair. The meta endpoint signs a nonce the frontend
 * chose, bound to the instance id; the frontend checks the signature with the public key it
 * pins (in a kit's connection manifest, M1-110). Both sides build the signed text here, and
 * the check runs on Web Crypto, so it works in browsers and in Node alike.
 */

/** What the meta endpoint signs: the scheme, the instance id and the caller's nonce. */
export function signedMetaText(instanceId: string, nonce: string): string {
  return `taskmoor-meta-v1\n${instanceId}\n${nonce}`;
}

/** A nonce as the meta endpoint takes it: 16 to 128 base64url characters. */
export const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface PinnedInstance {
  id: string;
  /** The instance's public key, SPKI DER in base64url. */
  publicKey: string;
}

/**
 * Whether a meta answer comes from the pinned instance: the same id and key, and a valid
 * signature over the nonce this frontend sent. Any malformed part counts as a mismatch.
 */
export async function verifyInstance(
  pinned: PinnedInstance,
  answer: { instance: { id: string; publicKey: string }; signature?: { value: string } | null },
  nonce: string,
): Promise<boolean> {
  if (answer.instance.id !== pinned.id || answer.instance.publicKey !== pinned.publicKey) {
    return false;
  }
  if (!answer.signature) return false;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      fromBase64url(pinned.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64url(answer.signature.value),
      new TextEncoder().encode(signedMetaText(pinned.id, nonce)),
    );
  } catch {
    return false;
  }
}

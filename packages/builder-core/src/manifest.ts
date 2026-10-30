import { canonicalJson, fromBase64url, toBase64url, utf8 } from './bytes';
import { apiOrigin, type BuilderInputs, basePath, frontendOrigin } from './inputs';
import { type GeneratedSecrets, instancePrivateKey, keyFingerprint } from './secrets';

/**
 * The connection manifest (M1-109; OPS-014, ADR-031): what both kits agree on about the
 * instance, signed with the instance's private key. The backend kit installs with it; the
 * frontend kit pins its instance id and public key and checks them against the backend's meta
 * endpoint (`verifyInstance` in `@taskmoor/webconfig`) before it runs.
 */
export const MANIFEST_FORMAT = 'taskmoor-connection-1';

export interface ConnectionManifest {
  format: typeof MANIFEST_FORMAT;
  instanceId: string;
  instanceName: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  keyFingerprint: string;
  /** The backend's origin. */
  apiUrl: string;
  /** Where WebSockets connect: the backend's origin with a ws scheme. */
  wsUrl: string;
  /** Origins the backend lets in (CORS, WebSocket origin checks). */
  frontendOrigins: string[];
  /** Where sign-in may return to (OAuth redirect base). */
  redirectUris: string[];
  routing: 'path' | 'hash';
  basePath: string;
  /** The backend image the kit pins. */
  backendVersion: string;
  /** The Builder that made the kits. */
  kitVersion: string;
}

export interface SignedManifest {
  manifest: ConnectionManifest;
  /** Ed25519 over `taskmoor-manifest-v1` and the manifest's canonical JSON, base64url. */
  signature: string;
}

const signedText = (manifest: ConnectionManifest) =>
  utf8(`taskmoor-manifest-v1\n${canonicalJson(manifest)}`);

export function describeConnection(
  inputs: BuilderInputs,
  secrets: GeneratedSecrets,
  versions: { backendVersion: string; kitVersion: string },
): ConnectionManifest {
  const api = apiOrigin(inputs);
  return {
    format: MANIFEST_FORMAT,
    instanceId: secrets.instanceId,
    instanceName: inputs.instanceName,
    publicKey: secrets.instanceKey.publicKey,
    keyFingerprint: secrets.instanceKey.fingerprint,
    apiUrl: api,
    wsUrl: api.replace(/^http/, 'ws'),
    frontendOrigins: [frontendOrigin(inputs)],
    redirectUris: [new URL(inputs.frontendUrl).href],
    routing: inputs.routing,
    basePath: basePath(inputs),
    backendVersion: versions.backendVersion,
    kitVersion: versions.kitVersion,
  };
}

export async function signManifest(
  manifest: ConnectionManifest,
  seed: string,
): Promise<SignedManifest> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    await instancePrivateKey(seed),
    signedText(manifest),
  );
  return { manifest, signature: toBase64url(new Uint8Array(signature)) };
}

/**
 * Whether a manifest is whole: signed by the key it names, and that key matches its
 * fingerprint. Whether the backend holds the key is the meta endpoint's nonce check.
 */
export async function verifyManifest(signed: SignedManifest): Promise<boolean> {
  try {
    const { manifest } = signed;
    if (manifest.format !== MANIFEST_FORMAT) return false;
    if ((await keyFingerprint(manifest.publicKey)) !== manifest.keyFingerprint) return false;
    const key = await crypto.subtle.importKey(
      'spki',
      fromBase64url(manifest.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64url(signed.signature),
      signedText(manifest),
    );
  } catch {
    return false;
  }
}

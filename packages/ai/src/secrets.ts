import { z } from 'zod';

/** Configuration never holds a credential, only a reference to one in the secret store. */
export const secretRefSchema = z.object({ secretId: z.string().min(1) });
export type SecretRef = z.infer<typeof secretRefSchema>;

export interface SecretStore {
  reveal(ref: SecretRef): Promise<string>;
}

/** For tests and single-process development. Production uses the envelope-encrypted store (M1). */
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [id, value] of Object.entries(entries)) this.values.set(id, value);
  }

  set(id: string, value: string): void {
    this.values.set(id, value);
  }

  async reveal(ref: SecretRef): Promise<string> {
    const value = this.values.get(ref.secretId);
    if (value === undefined) throw new Error(`Unknown secret "${ref.secretId}"`);
    return value;
  }
}

/** Replaces every occurrence of the given secret values with [redacted]. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

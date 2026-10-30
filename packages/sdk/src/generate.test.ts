import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateSdk } from './generate';

/** The SDK's generated files match the committed API document (M1-065; API-001 (2)). */
describe('the generated SDK (M1-065)', () => {
  it('[API-001] is generated from the current API document', async () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'),
    );
    const { schema, operations } = await generateSdk(spec);
    await expect(schema).toMatchFileSnapshot('./generated/schema.ts');
    await expect(operations).toMatchFileSnapshot('./generated/operations.ts');
    expect(operations).toContain(
      "getTicket: { method: 'GET', path: '/api/v1/tickets/{id}', paged: false },",
    );
    expect(operations).not.toContain('internal-');
  });
});

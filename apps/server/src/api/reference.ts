/**
 * The API reference page (`docs/api/reference.md`), written from the API document (M1-065;
 * ADR-067): every stable operation by area with its parameters, body and responses, then the
 * shared schemas. The words come from the operation catalogue, so the page never disagrees
 * with the document; `openapi.test.ts` keeps it current.
 */
type Json = Record<string, unknown>;

/** The anchor GitHub and most Markdown renderers give a heading. */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');

const cell = (text: unknown) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ');

function deref(schema: unknown, doc: Json): { schema: Json; name: string | null } {
  const s = (schema ?? {}) as Json;
  if (typeof s.$ref === 'string' && s.$ref.startsWith('#/components/schemas/')) {
    const name = s.$ref.slice('#/components/schemas/'.length);
    return { schema: (((doc.components as Json).schemas as Json)[name] ?? {}) as Json, name };
  }
  return { schema: s, name: null };
}

/** A schema's type in a few words, with links to named schemas. */
function typeText(schema: unknown, doc: Json): string {
  const s = (schema ?? {}) as Json;
  if (typeof s.$ref === 'string') {
    const name = s.$ref.split('/').pop() as string;
    return `[${name}](#${slug(`Schema: ${name}`)})`;
  }
  if (Array.isArray(s.anyOf)) return (s.anyOf as Json[]).map((x) => typeText(x, doc)).join(' or ');
  if (Array.isArray(s.enum))
    return (s.enum as unknown[]).map((v) => `\`${JSON.stringify(v)}\``).join(', ');
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.type === 'array') return `array of ${typeText(s.items, doc)}`;
  if (Array.isArray(s.type)) return (s.type as string[]).join(' or ');
  if (typeof s.type === 'string') return s.type === 'object' && !s.properties ? 'object' : s.type;
  return 'any';
}

function propertyTable(schema: unknown, doc: Json): string[] {
  const { schema: s } = deref(schema, doc);
  const props = (s.properties ?? {}) as Record<string, Json>;
  const required = new Set((s.required ?? []) as string[]);
  if (Object.keys(props).length === 0) return [];
  return [
    '| Name | Type | Required | Meaning |',
    '| --- | --- | --- | --- |',
    ...Object.entries(props).map(
      ([name, p]) =>
        `| \`${name}\` | ${cell(typeText(p, doc))} | ${required.has(name) ? 'yes' : 'no'} | ${cell(p.description)} |`,
    ),
  ];
}

export function renderReference(doc: Json): string {
  const info = doc.info as Json;
  const byTag = new Map<string, { method: string; path: string; op: Json }[]>();
  let internal = 0;
  for (const [path, item] of Object.entries(doc.paths as Record<string, Json>)) {
    for (const [method, op] of Object.entries(item as Record<string, Json>)) {
      if (op['x-taskmoor-stability'] !== 'stable') {
        internal++;
        continue;
      }
      const tag = (op.tags as string[])[0] as string;
      byTag.set(tag, [...(byTag.get(tag) ?? []), { method: method.toUpperCase(), path, op }]);
    }
  }
  const tags = [...byTag.keys()].sort();
  const lines: string[] = [
    `# Taskmoor API v${info.version} reference`,
    '',
    'Generated from [openapi.json](openapi.json) by `apps/server/src/api/reference.ts`; do not edit',
    'it by hand. How to authenticate, page, read errors and what "stable" promises are in the',
    '[API guide](README.md).',
    '',
    '## Contents',
    '',
    ...tags.map((t) => `- [${t}](#${slug(t)})`),
    '- [Schemas](#schemas)',
    '- [Internal routes](#internal-routes)',
    '',
  ];
  for (const tag of tags) {
    lines.push(`## ${tag}`, '');
    const ops = (byTag.get(tag) ?? []).sort((a, b) =>
      `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
    );
    for (const { method, path, op } of ops) {
      lines.push(`### ${op.summary}`, '');
      lines.push(
        `\`${method} ${path}\`, operation \`${op.operationId}\`, access: ${op['x-taskmoor-access']}${
          op['x-taskmoor-paging'] ? ', paged by cursor' : ''
        }.`,
        '',
      );
      if (op.description) lines.push(String(op.description), '');
      const params = (op.parameters ?? []) as Json[];
      if (params.length > 0) {
        lines.push(
          '| Parameter | In | Type | Required | Meaning |',
          '| --- | --- | --- | --- | --- |',
          ...params.map(
            (p) =>
              `| \`${p.name}\` | ${p.in} | ${cell(typeText(p.schema, doc))} | ${p.required ? 'yes' : 'no'} | ${cell(p.description)} |`,
          ),
          '',
        );
      }
      const body = (
        ((op.requestBody as Json | undefined)?.content as Json | undefined)?.['application/json'] as
          | Json
          | undefined
      )?.schema;
      if (body) {
        const table = propertyTable(body, doc);
        lines.push('Body:', '', ...(table.length > 0 ? table : [`A ${typeText(body, doc)}.`]), '');
      }
      lines.push('Responses:', '');
      for (const [status, response] of Object.entries(op.responses as Record<string, Json>)) {
        const schema = (
          (response.content as Json | undefined)?.['application/json'] as Json | undefined
        )?.schema;
        const inline = schema
          ? ((schema as Json).properties as Record<string, Json> | undefined)
          : undefined;
        const shown = !schema
          ? ''
          : inline
            ? ` Body: ${Object.entries(inline)
                .map(([name, p]) => `\`${name}\` (${typeText(p, doc)})`)
                .join(', ')}.`
            : ` Body: ${typeText(schema, doc)}.`;
        lines.push(`- ${status}: ${response.description}${/^2/.test(status) ? shown : ''}`);
      }
      lines.push('');
    }
  }
  lines.push('## Schemas', '');
  const schemas = (doc.components as Json).schemas as Record<string, Json>;
  for (const [name, schema] of Object.entries(schemas)) {
    lines.push(`### Schema: ${name}`, '');
    if (schema.description) lines.push(String(schema.description), '');
    const table = propertyTable(schema, doc);
    lines.push(...(table.length > 0 ? table : [`A ${typeText(schema, doc)}.`]), '');
  }
  lines.push(
    '## Internal routes',
    '',
    `The document also lists ${internal} internal routes (\`x-taskmoor-stability: internal\`): they serve`,
    'the web app and may change in any release, so programs should not rely on them.',
    '',
  );
  return lines.join('\n');
}

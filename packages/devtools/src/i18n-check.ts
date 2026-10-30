import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * The hard-coded string check (M1-116; NFR-006 (1)): every text a person reads in the web app
 * comes from the message catalogue. It parses each component (TSX) and reports:
 * - text written between JSX tags that holds a letter;
 * - a literal string, or a template without substitutions, given to an attribute a person
 *   reads or hears: `aria-label`, `title`, `placeholder`, `alt` and the like.
 *
 * Technical text inside `<code>`, `<kbd>`, `<pre>` and `<samp>` is not language. A line that
 * says `i18n-ignore` is skipped, for the rare literal that is not language either, such as a
 * product name in a logo. Tests, stories and fixtures are not the app and are not checked; the
 * en-XA pseudo-locale tests cover what they render.
 */
export interface StringFinding {
  file: string;
  line: number;
  text: string;
}

const READ_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
]);
const TECHNICAL = new Set(['code', 'kbd', 'pre', 'samp']);
const LETTER = /\p{L}/u;

function tagName(node: ts.JsxElement): string {
  return node.openingElement.tagName.getText();
}

/** The findings in one TSX source. */
export function findHardCodedStrings(source: string, file: string): StringFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split('\n');
  const findings: StringFinding[] = [];
  const report = (node: ts.Node, text: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    // The ignore marker on the line itself or the line above (a JSX comment line).
    if (lines[line]?.includes('i18n-ignore') || lines[line - 1]?.includes('i18n-ignore')) return;
    findings.push({ file, line: line + 1, text: text.trim().replace(/\s+/g, ' ') });
  };
  const visit = (node: ts.Node, technical: boolean): void => {
    if (ts.isJsxElement(node)) {
      const inside = technical || TECHNICAL.has(tagName(node));
      visit(node.openingElement, inside);
      for (const child of node.children) visit(child, inside);
      return;
    }
    if (ts.isJsxText(node)) {
      if (!technical && LETTER.test(node.text)) report(node, node.text);
      return;
    }
    if (ts.isJsxAttribute(node) && READ_ATTRIBUTES.has(node.name.getText())) {
      const init = node.initializer;
      const literal =
        init && ts.isStringLiteral(init)
          ? init
          : init && ts.isJsxExpression(init) && init.expression
            ? init.expression
            : undefined;
      if (
        literal &&
        (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) &&
        LETTER.test(literal.text)
      ) {
        report(node, `${node.name.getText()}="${literal.text}"`);
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, technical));
  };
  visit(sf, false);
  return findings;
}

const SKIP = /\.(test|stories)\.tsx$|(^|\/)(fixtures?|test|testing)(\/|\.tsx$)/;

/** Every component of the web app under `dir`, as paths relative to `root`. */
export function webComponents(root: string, dir = join(root, 'apps', 'web', 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...webComponents(root, path));
    else if (entry.name.endsWith('.tsx')) {
      const rel = relative(root, path).split('\\').join('/');
      if (!SKIP.test(rel)) out.push(rel);
    }
  }
  return out.sort();
}

/** The findings across the web app. */
export function checkWebStrings(root: string): StringFinding[] {
  return webComponents(root).flatMap((file) =>
    findHardCodedStrings(readFileSync(join(root, file), 'utf8'), file),
  );
}

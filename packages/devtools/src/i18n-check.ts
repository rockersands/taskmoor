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

/**
 * The English catalogue's house style (TR-34 and the second page sweep), the way most of it was
 * already written: the curly apostrophe (’), never the straight one, and British spellings
 * (colour, organisation, customise, minimise, summarise), never the American ones. Placeholders
 * such as `{key}` and other products' names, such as Jira Data Center, are not ours to spell.
 */
const US_SPELLINGS: readonly RegExp[] = [
  // -ize, -ized, -izing, -ization and the like, but not size, prize or seize.
  /\b(?!(?:re|over|down)?siz|pri[sz]|sei[sz])[a-z]+iz(?:e|es|ed|ing|ation|ations|er|ers)\b/i,
  /\b[a-z]+yz(?:e|es|ed|ing)\b/i,
  /\b(?:colors?|colored|colorful|behaviors?|favorites?|neighbors?|neighboring|honors?)\b/i,
  /\b(?:labeled|labeling|canceled|canceling|traveled|traveling|modeling|grays?|catalogs?)\b/i,
  /\bcent(?:er|ers|ered)\b/i,
];
const NOT_OURS = [/\{[A-Za-z]+\}/g, /\bJira Data Center\b/g, /\bGoogle Workspace\b/g];

/** What breaks the house style in one English message, said in a few words; none when it keeps it. */
export function styleProblems(text: string): string[] {
  let ours = text;
  for (const name of NOT_OURS) ours = ours.replace(name, ' ');
  const problems: string[] = [];
  if (ours.includes("'")) problems.push("a straight apostrophe (')");
  for (const spelling of US_SPELLINGS) {
    const found = spelling.exec(ours);
    if (found) problems.push(`the American spelling '${found[0]}'`);
  }
  return problems;
}

/** The messages of a catalogue source (an object of string literals) that break the house style. */
export function findCatalogueStyle(source: string, file: string): StringFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: StringFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer)) {
      const problems = styleProblems(node.initializer.text);
      if (problems.length > 0) {
        const line = sf.getLineAndCharacterOfPosition(node.initializer.getStart(sf)).line;
        findings.push({
          file,
          line: line + 1,
          text: `${node.name.getText(sf)}: ${problems.join(', ')}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** The English catalogue's messages that break the house style. */
export function checkCatalogueStyle(root: string): StringFinding[] {
  const file = 'apps/web/src/i18n/messages.en.ts';
  return findCatalogueStyle(readFileSync(join(root, file), 'utf8'), file);
}

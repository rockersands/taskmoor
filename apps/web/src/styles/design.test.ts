import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DRAGGED_WHOLE, GRIP_SELECTORS } from '../test/grips';
import { ALLOWED, OFFENDERS, type Ratchet } from './design-offenders';

/**
 * The design guard (ADR-114, T-144): what makes the app read as one design, where a machine can
 * tell. Read from disk, as motion.test.ts does: the web project turns CSS imports off.
 *
 * What it holds: no raw colour outside tokens.css; no opaque surface token on anything but a field
 * or a place with a named reason; menus, pop-overs, the command palette and dialogs on the one
 * opaque overlay fill with no blur (D3); links in the accent; a finger's height wherever a mouse's is set;
 * radii, font sizes and font weights only from the tokens; one level-one heading, from PageHeader;
 * a PageHeader, with a purpose line, on every route page, on its failures too, and in an element of
 * class `page`; no unstyled button or table; no fieldset whose class has no rule; no bare "none
 * yet" sentence where an EmptyState goes, under whatever class; no glass card inside a glass card;
 * no check box or radio drawn otherwise than forms.css draws them all.
 *
 * `design-offenders.ts` holds two lists. OFFENDERS is what is still to fix, counted per file; the
 * count must match in both directions, so it only shrinks, and when it is empty the sweep is
 * finished. ALLOWED is what stays for good, one entry and one reason each.
 *
 * What it cannot check, and who does instead:
 * - Whether anything looks like glass, or how a page reads in either skin or at 360 px: the Chrome
 *   pass of UI-T22 on every route.
 * - Backdrop-filter nested by anything but `glass-card`, a rim that adds scroll bars, sticky cells
 *   that show rows through them: the same pass. It reads text, and these are only seen when drawn.
 * - A failure a page draws in a component of its own, or by a word other than `role="alert"` or
 *   `board-problem`: a person. It reads the returns of the page's own function.
 * - A control that sets its height with no `--hit-target`, a link short only by its words: the
 *   touch stories, which measure what they cover.
 * - Whether a purpose line or an empty state says anything useful, spacing and hierarchy: a person.
 * - An empty message whose ID says neither "none" nor "empty", such as `noTickets`, or that is not
 *   the words of a `p`, `li`, `div`, `td` or `dd`; a list that stays quiet with no message at all; a
 *   class whose name merely contains "field": a person.
 * - Colours hidden in a custom property from elsewhere or built in JavaScript, class names
 *   assembled at runtime, and CSS from a dependency: nothing. It sees literals in the source.
 * - Contrast: contrast.test.ts for the tokens, axe in the stories for what is drawn.
 */
const SRC = ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'styles/tokens.css'))) ?? 'src';

function filesUnder(dir: string, wanted: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, wanted);
    return wanted(entry.name) ? [path] : [];
  });
}

/** A path from the source root, with forward slashes, on any system. */
const name = (path: string) => relative(SRC, path).replaceAll('\\', '/');

/* ---------------------------------------- CSS ---------------------------------------- */

interface Declaration {
  selector: string;
  property: string;
  value: string;
  /** The at-rules it sits in, outermost first. */
  atRules: string[];
}

/** Every declaration of a stylesheet with the selector it sits under, through nested at-rules. */
export function cssDeclarations(source: string): Declaration[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  let depth = 0;
  let quote = '';
  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    const colon = text.indexOf(':');
    if (colon < 0) return;
    const selector = stack.filter((s) => !s.startsWith('@')).at(-1) ?? '';
    const property = text.slice(0, colon).trim().toLowerCase();
    const atRules = stack.filter((s) => s.startsWith('@'));
    found.push({ selector, property, value: text.slice(colon + 1).trim(), atRules });
  };
  for (const c of css) {
    if (quote) {
      if (c === quote) quote = '';
      buffer += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      buffer += c;
    } else if (c === '(') {
      depth++;
      buffer += c;
    } else if (c === ')') {
      depth--;
      buffer += c;
    } else if (depth > 0) {
      buffer += c;
    } else if (c === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (c === ';') {
      flush();
    } else if (c === '}') {
      flush();
      stack.pop();
    } else {
      buffer += c;
    }
  }
  return found;
}

const withoutUrls = (value: string) => value.replace(/url\([^)]*\)/g, 'url()');
const RAW_COLOUR =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?!from\b)[\d.]/;
/** Masks only use a colour's alpha: `#000` there is the mask's solid part, not something seen. */
const isMask = (property: string) => /^(-webkit-)?mask/.test(property);

const OPAQUE_SURFACE = /var\(--color-surface(?:-sunken|-raised)?\b/;
const FILLS = /^(background(-color|-image)?|fill|--.+)$/;
/** The selector names a field: its own surface is what a field is for (forms.css). */
const FIELD =
  /(^|[\s>+~(,:])(input|select|textarea|option|optgroup)\b|\.[\w-]*(field|input|select|textarea)\b/;

const isRadiusToken = (part: string) => /^var\(--radius-[\w-]+\)$/.test(part);
/** The radii the design has; 0 and 50% are a square and a circle, and a multiple keeps its token. */
function radiusProblem(value: string): boolean {
  return value
    .replace(/calc\((var\(--radius-[\w-]+\))\s*\*\s*[\d.]+\)/g, '$1')
    .split(/[\s/]+/)
    .some((part) => !(part === '0' || part === '50%' || part === 'inherit' || isRadiusToken(part)));
}
const fontSizeProblem = (value: string) =>
  !/^var\(--font-size-[\w-]+\)$/.test(value) &&
  !/^-?[\d.]+em$/.test(value) &&
  value !== 'inherit' &&
  value !== '100%';
/** The shorthand may reset to what is around it, or name the size by a token. */
const fontShorthandProblem = (value: string) =>
  value !== 'inherit' && /\d(px|rem|pt)\b/.test(value) && !value.includes('var(--font-size-');

const fontWeightProblem = (value: string) =>
  !/^var\(--font-weight-[\w-]+\)$/.test(value) && value !== 'normal' && value !== 'inherit';

type Kind = 'rawColours' | 'opaqueSurfaces' | 'radii' | 'fontSizes' | 'fontWeights';

/** Which rule each declaration of a stylesheet breaks, as text to show the person who broke it. */
export function cssProblems(source: string): Record<Kind, string[]> {
  const problems: Record<Kind, string[]> = {
    rawColours: [],
    opaqueSurfaces: [],
    radii: [],
    fontSizes: [],
    fontWeights: [],
  };
  for (const { selector, property, value } of cssDeclarations(source)) {
    const text = `${selector} { ${property}: ${value.replace(/\s+/g, ' ')} }`;
    if (!isMask(property) && RAW_COLOUR.test(withoutUrls(value))) problems.rawColours.push(text);
    if (FILLS.test(property) && OPAQUE_SURFACE.test(value)) {
      const named = (part: string) =>
        FIELD.test(part) || part.trim() in (ALLOWED.opaqueSurfaces as Record<string, string>);
      if (!selector.split(',').every(named)) problems.opaqueSurfaces.push(text);
    }
    if (/^border(-[a-z]+)*-radius$/.test(property) && radiusProblem(value)) {
      problems.radii.push(text);
    }
    if (property === 'font-size' && fontSizeProblem(value)) problems.fontSizes.push(text);
    if (property === 'font' && fontShorthandProblem(value)) problems.fontSizes.push(text);
    if (property === 'font-weight' && fontWeightProblem(value)) problems.fontWeights.push(text);
  }
  return problems;
}

/**
 * Menus, pop-overs, the command palette and dialogs (D3, T-220): opaque, so nothing on the page
 * shows through them, and with no blur, which would hold a fixed surface opened inside them.
 * surfaces.css draws them all in one rule.
 */
export const OVERLAYS = [
  '.shell-drawer',
  '.help-tip-body',
  '.user-menu-popup',
  '.icon-select-list',
  '.rt-mentions',
  '.popover',
  '.palette',
  '.create-dialog',
  '.ticket-dialog',
  '.board-choice',
] as const;

const OVERLAY_FILL = 'var(--overlay-fill)';
const isFill = (property: string) => /^background(-color)?$/.test(property);
const isBlur = (property: string) => /^(-webkit-)?backdrop-filter$/.test(property);

/**
 * What leaves an overlay see-through, read across stylesheets in the order the app loads them:
 * an overlay whose last plain rule is not the opaque fill with no blur, a rule that names one more
 * closely (a variant, a media query) and gives it glass back, and the opaque fill on anything else.
 */
export function overlayProblems(
  sheets: readonly (readonly [string, string])[],
  overlays: readonly string[] = OVERLAYS,
): string[] {
  const problems: string[] = [];
  const last = new Map<string, string>();
  // The overlay itself in another guise; its rim, a pseudo-element, is glass on purpose.
  const names = (part: string, overlay: string) => {
    const subject = part.split(/[\s>+~]+/).at(-1) ?? '';
    return (
      !subject.includes('::') &&
      new RegExp(`${overlay.replace('.', '\\.')}(?![\\w-])`).test(subject)
    );
  };
  for (const [file, source] of sheets) {
    for (const { selector, property, value, atRules } of cssDeclarations(source)) {
      const parts = selectorsOf(selector);
      const text = `${file}: ${selector} { ${property}: ${value.replace(/\s+/g, ' ')} }`;
      if (value.includes('--overlay-fill') && !parts.every((part) => overlays.includes(part))) {
        problems.push(`the overlay fill on something else: ${text}`);
      }
      if (!isFill(property) && !isBlur(property)) continue;
      for (const part of parts) {
        if (overlays.includes(part) && atRules.length === 0) {
          last.set(`${part} ${isFill(property) ? 'background' : property}`, value);
        } else if (
          overlays.some((overlay) => names(part, overlay)) &&
          (isFill(property) ? value.includes('--glass-') : value.includes('blur('))
        ) {
          problems.push(`glass again on an overlay: ${text}`);
        }
      }
    }
  }
  for (const overlay of overlays) {
    const fill = last.get(`${overlay} background`);
    if (fill !== OVERLAY_FILL) problems.push(`${overlay} ends on ${fill ?? 'no fill'}`);
    for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
      const blur = last.get(`${overlay} ${property}`);
      if (blur !== 'none') problems.push(`${overlay} ends on ${property}: ${blur ?? 'unset'}`);
    }
  }
  return problems;
}

/** A selector list's parts, with a comma inside `:is(a, b)` left where it is. */
export function selectorsOf(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const c of list) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else {
      part += c;
    }
  }
  parts.push(part);
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** A media query that holds only at some sizes of screen: every one of its alternatives asks for one. */
const sizeGated = (at: string) =>
  at.startsWith('@media') &&
  at
    .slice('@media'.length)
    .split(',')
    .every((query) => /\b(width|height)\b/.test(query));
/**
 * A rule for every touch screen: under `(pointer: coarse)` and under no query of the screen's
 * size, which once hid a grip's finger size from wide touch screens with every test green (T-231).
 */
const isTouchRule = (d: Declaration) =>
  d.atRules.some((at) => at.includes('pointer: coarse')) && !d.atRules.some(sizeGated);
const FINGER = /var\(--hit-target-touch\)|^44px$/;

/**
 * Selectors with a mouse's height that no `(pointer: coarse)` rule gives a finger's: the height a
 * touch screen needs is one line away in the same stylesheets (ADR-033). A touch rule that asks for
 * the mouse's height is the same mistake.
 */
export function shortOnTouch(sources: string[]): string[] {
  const declarations = sources.flatMap(cssDeclarations);
  const sized = declarations.filter((d) => d.property === 'min-height' || d.property === 'height');
  const fingers = new Set(
    sized
      .filter((d) => isTouchRule(d) && FINGER.test(d.value))
      .flatMap((d) => selectorsOf(d.selector)),
  );
  const short = sized
    .filter((d) => d.value === 'var(--hit-target)')
    .flatMap((d) => selectorsOf(d.selector));
  return [...new Set(short)].filter((selector) => !fingers.has(selector)).sort();
}

/** A cursor that says "drag me": a grab, a grabbing hand or a move, whatever its fallbacks. */
const GRAB_CURSOR = /^(?:-webkit-|-moz-)?(?:grab|grabbing|move)(?:\s*!important)?$/;

/**
 * Grips no touch check knows of (T-290): every selector with both `touch-action: none` and a grab
 * cursor, read across all the stylesheets and their at-rules, whose element is not one of `listed`
 * (GRIP_SELECTORS and DRAGGED_WHOLE). Such a selector is a grip: a finger drags by it, so it needs a
 * finger's size, which the stories measure only for the grips they are told of. A listed grip in a
 * place of its own, or in a state (`.x .move-grip-handle:hover`), is the same grip.
 */
export function unlistedGrips(sources: string[], listed: readonly string[]): string[] {
  // A selector without its trailing states, so a grip's `:hover` is the grip.
  const element = (part: string) => part.replace(/(?::{1,2}[\w-]+(?:\([^)]*\))?)+$/, '');
  const pinned = new Set<string>();
  const grabbed = new Set<string>();
  for (const d of sources.flatMap(cssDeclarations)) {
    const value = d.value.toLowerCase();
    const parts = selectorsOf(d.selector).map(element);
    if (d.property === 'touch-action' && /^none\b/.test(value)) {
      for (const part of parts) pinned.add(part);
    }
    if (d.property === 'cursor' && value.split(',').some((v) => GRAB_CURSOR.test(v.trim()))) {
      for (const part of parts) grabbed.add(part);
    }
  }
  const known = (part: string) => {
    const subject = part.split(/[\s>+~]+/).at(-1) ?? '';
    return listed.some((grip) =>
      new RegExp(`${grip.replaceAll('.', '\\.')}(?![\\w-])`).test(subject),
    );
  };
  return [...pinned].filter((part) => grabbed.has(part) && !known(part)).sort();
}

/**
 * What is wrong with `checkedBy` (`file#Story`, the file under `root`) as the story that checks a
 * dragged-whole element's finger's size (T-290): no such file, no such story exported from it, or a
 * story that does not run on a real touch screen. Undefined when it is that story.
 */
export function touchStoryProblem(root: string, checkedBy: string): string | undefined {
  const [file, story] = checkedBy.split('#');
  if (!file || !story) return `${checkedBy} is not file#Story`;
  const path = join(root, file);
  if (!/\.stories\.tsx$/.test(file) || !existsSync(path)) return `${file} is not a story file`;
  const source = readFileSync(path, 'utf8');
  const start = source.search(new RegExp(`export const ${story}\\b`));
  if (start < 0) return `${file} exports no ${story}`;
  const next = source.slice(start + 1).search(/\nexport const /);
  const body = next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  if (!/beforeEach:\s*onARealTouchScreen\b/.test(body)) {
    return `${checkedBy} does not run on a real touch screen`;
  }
  return undefined;
}

/* ---------------------------------------- TSX ---------------------------------------- */

const parse = (file: string, source: string) =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const tagName = (node: ts.JsxOpeningLikeElement) => node.tagName.getText();

function attribute(node: ts.JsxOpeningLikeElement, wanted: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === wanted,
  );
}

const hasSpread = (node: ts.JsxOpeningLikeElement) =>
  node.attributes.properties.some(ts.isJsxSpreadAttribute);

/** The class names written in a className, even in a conditional; what is built at runtime is not. */
function classesOf(node: ts.JsxOpeningLikeElement): string[] {
  const init = attribute(node, 'className')?.initializer;
  if (!init) return [];
  const classes: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) classes.push(...n.text.split(/\s+/).filter(Boolean));
    ts.forEachChild(n, walk);
  };
  walk(init);
  return classes;
}

export interface JsxFacts {
  /** Level-one headings and `page-title`s written here, by tag. */
  titles: string[];
  pageHeaders: number;
  /** PageHeaders with no purpose attribute. */
  noPurpose: number;
  bareButtons: number;
  bareTables: number;
  /** The class of each fieldset that has one. */
  fieldsetClasses: string[];
  /** Message IDs that say "none" or "empty", as the words of a plain element. */
  bareEmpties: string[];
  /** The classes of the element around each PageHeader; none for one kept in a variable. */
  headerParents: string[][];
  /** Every class written in the file. */
  allClasses: Set<string>;
  /** A `glass-card` written inside another in the same file, by tag. */
  nestedGlass: string[];
  /** Components rendered inside a `glass-card`, by tag. */
  renderedInGlass: Set<string>;
  rawColours: string[];
  /** The opaque surface tokens written in a script. */
  opaqueSurfaces: string[];
  /** Inline fontSize or borderRadius with a literal value. */
  literalSizes: string[];
  /** Components rendered here, by tag. */
  rendered: Set<string>;
}

const STRING_COLOUR = /^#[0-9a-fA-F]{3,8}$|^(?:rgba?|hsla?)\(\s*[\d.]/;
/** Elements whose words are a sentence of their own: a "none" there is a list's empty state. */
const SENTENCES = new Set(['p', 'li', 'div', 'td', 'dd']);
/** A message ID for "there are none": `x.none`, `x.empty`, `x.noTabs` (but not `x.notes`). */
const EMPTY_ID = /[Nn]one|[Ee]mpty|\.no[A-Z]/;

/** What the stylesheets say: `.parent button` lets a bare button sit under `.parent`. */
export interface StyledBy {
  classes: Set<string>;
  parentsOf: Record<'button' | 'table', Set<string>>;
}

export function styledBy(css: string[]): StyledBy {
  const styled: StyledBy = {
    classes: new Set(),
    parentsOf: { button: new Set(), table: new Set() },
  };
  for (const source of css) {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{/g)) {
      const selectors = (m[1] as string).trim();
      if (selectors.startsWith('@')) continue;
      for (const c of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        styled.classes.add(c[1] as string);
      }
      for (const selector of selectors.split(',')) {
        for (const tag of ['button', 'table'] as const) {
          const at = selector.search(new RegExp(`(^|[\\s>+~])${tag}\\b`));
          if (at < 0) continue;
          for (const c of selector.slice(0, at).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
            styled.parentsOf[tag].add(c[1] as string);
          }
        }
      }
    }
  }
  return styled;
}

export function jsxFacts(file: string, source: string, styled: StyledBy): JsxFacts {
  const facts: JsxFacts = {
    titles: [],
    pageHeaders: 0,
    noPurpose: 0,
    bareButtons: 0,
    bareTables: 0,
    fieldsetClasses: [],
    bareEmpties: [],
    headerParents: [],
    allClasses: new Set(),
    nestedGlass: [],
    renderedInGlass: new Set(),
    rawColours: [],
    opaqueSurfaces: [],
    literalSizes: [],
    rendered: new Set(),
  };
  const visit = (
    node: ts.Node,
    ancestors: string[],
    inNote: boolean,
    parent: string[] | null,
  ): void => {
    let classes = ancestors;
    let note = inNote;
    let around = parent;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagName(node);
      const own = classesOf(node);
      const unstyled = !attribute(node, 'className') && !hasSpread(node);
      for (const c of own) facts.allClasses.add(c);
      if (tag === 'h1' || own.includes('page-title')) facts.titles.push(tag);
      if (tag === 'PageHeader') {
        facts.pageHeaders++;
        if (!attribute(node, 'purpose') && !hasSpread(node)) facts.noPurpose++;
        if (parent) facts.headerParents.push(parent);
      }
      if (tag === 'button' && unstyled) {
        if (!ancestors.some((c) => styled.parentsOf.button.has(c))) facts.bareButtons++;
      }
      if (tag === 'table' && unstyled) {
        if (!ancestors.some((c) => styled.parentsOf.table.has(c))) facts.bareTables++;
      }
      if (tag === 'fieldset') facts.fieldsetClasses.push(...own);
      if (/^[A-Z]/.test(tag)) facts.rendered.add(tag);
      const style = attribute(node, 'style')?.initializer;
      if (style) {
        const walk = (n: ts.Node) => {
          if (
            ts.isPropertyAssignment(n) &&
            /^(fontSize|borderRadius)$/.test(n.name.getText()) &&
            (ts.isNumericLiteral(n.initializer) ||
              (ts.isStringLiteralLike(n.initializer) && !n.initializer.text.startsWith('var(')))
          ) {
            facts.literalSizes.push(n.getText());
          }
          ts.forEachChild(n, walk);
        };
        walk(style);
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const own = classesOf(opening);
      const tag = tagName(opening);
      if (ancestors.includes('glass-card')) {
        if (own.includes('glass-card')) facts.nestedGlass.push(tag);
        if (/^[A-Z]/.test(tag)) facts.renderedInGlass.add(tag);
      }
      classes = [...ancestors, ...own];
      note = ts.isJsxElement(node) && SENTENCES.has(tag);
      around = own;
    }
    // What an attribute says is no sentence of the element's: a title, a label, a component's prop.
    if (ts.isJsxAttribute(node)) note = false;
    if (
      note &&
      ts.isCallExpression(node) &&
      node.expression.getText() === 't' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      EMPTY_ID.test(node.arguments[0].text)
    ) {
      facts.bareEmpties.push(node.arguments[0].text);
    }
    if (ts.isStringLiteralLike(node)) {
      if (STRING_COLOUR.test(node.text)) facts.rawColours.push(node.text);
      if (OPAQUE_SURFACE.test(node.text)) facts.opaqueSurfaces.push(node.text);
    }
    ts.forEachChild(node, (child) => visit(child, classes, note, around));
  };
  visit(parse(file, source), [], false, null);
  return facts;
}

/** What draws a check box: its kind, its fill, its edge, its shadow, a mark over it. */
const DRAWS_A_BOX =
  /^((-webkit-)?(appearance|mask)|background(-color)?|border(-color)?|box-shadow)$/;

/**
 * Check boxes and radios that a page draws its own way (TR-24, AC-11): a class written on an
 * `<input type="checkbox">` or `"radio"` that a stylesheet gives a look of its own, where forms.css
 * draws every one alike. Sizes and placement are a page's own and stay out of it.
 */
export function ownCheckBoxes(
  scripts: readonly (readonly [string, string])[],
  sheets: readonly (readonly [string, string])[],
): string[] {
  const classes = new Set<string>();
  for (const [file, source] of scripts) {
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        tagName(node) === 'input'
      ) {
        const type = attribute(node, 'type')?.initializer;
        if (type && ts.isStringLiteral(type) && /^(checkbox|radio)$/.test(type.text)) {
          for (const name of classesOf(node)) classes.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file, source));
  }
  return sheets.flatMap(([file, source]) =>
    cssDeclarations(source)
      .filter((d) => DRAWS_A_BOX.test(d.property))
      .filter((d) =>
        selectorsOf(d.selector).some((part) => {
          // The element the rule draws, less its pseudo-element and what it says it is not.
          const last = part.split(/[\s>+~]+/).at(-1) ?? '';
          const subject = (last.split('::')[0] ?? '').replace(/:not\([^)]*\)/g, '');
          return [...classes].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(subject));
        }),
      )
      .map((d) => `${file}: ${d.selector} { ${d.property} }`),
  );
}

/** Where each component a file imports from another of our files comes from. */
function importsOf(file: string, source: string): Map<string, string> {
  const found = new Map<string, string>();
  parse(file, source).forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const from = node.moduleSpecifier.text;
    if (!from.startsWith('.')) return;
    const path = join(file, '..', from);
    const target = [`${path}.tsx`, `${path}.ts`].find((f) => existsSync(f));
    const bindings = node.importClause?.namedBindings;
    if (!target || !bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) found.set(element.name.text, target);
  });
  return found;
}

/* -------------------------------------- the checks ------------------------------------- */

const stylesheets = filesUnder(SRC, (n) => n.endsWith('.css'));
const cssSources = stylesheets.map((f) => [f, readFileSync(f, 'utf8')] as const);
const styled = styledBy(cssSources.map(([, source]) => source));
const scripts = filesUnder(SRC, (n) => /\.tsx?$/.test(n) && !/\.(test|stories)\.tsx?$/.test(n));
const facts = new Map(
  scripts.map((file) => [file, jsxFacts(file, readFileSync(file, 'utf8'), styled)]),
);
const factsOf = (file: string) => facts.get(file) as JsxFacts;
const APP = join(SRC, 'App.tsx');

/** Every *Page component App.tsx imports. */
function routePages(): Map<string, string> {
  return new Map(
    [...importsOf(APP, readFileSync(APP, 'utf8'))].filter(([component]) =>
      component.endsWith('Page'),
    ),
  );
}

/** A page has a header if it, or a component of ours it renders, draws one. */
function drawsHeader(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file) || !facts.has(file)) return false;
  seen.add(file);
  if (factsOf(file).pageHeaders > 0) return true;
  const imports = importsOf(file, readFileSync(file, 'utf8'));
  return [...factsOf(file).rendered].some((tag) => {
    const target = imports.get(tag);
    return target !== undefined && drawsHeader(target, seen);
  });
}

const FUNCTION = (node: ts.Node) => ts.isFunctionLike(node) && !ts.isCallSignatureDeclaration(node);

/** The function a component is declared with, in a file of our source. */
function componentFunction(sourceFile: ts.SourceFile, component: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === component) found = node;
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === component &&
      node.initializer &&
      FUNCTION(node.initializer)
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The failures a route page returns with no header: an alert alone on the page. Reads the returns
 * of the page's own function; a component it returns instead answers for itself by `drawsHeader`.
 */
function failuresWithoutHeader(file: string, component: string): string[] {
  const source = readFileSync(file, 'utf8');
  const sourceFile = parse(file, source);
  const body = componentFunction(sourceFile, component);
  if (!body) return [];
  const imports = importsOf(file, source);
  const problems: string[] = [];
  // A header kept in a variable and written as `{titled}`.
  const held = new Set<string>();
  const hold = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer?.getText().includes('<PageHeader')) {
      held.add(node.name.getText());
    }
    ts.forEachChild(node, hold);
  };
  hold(body);
  const check = (jsx: ts.Node) => {
    let alert = false;
    let header = false;
    const look = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = tagName(node);
        if (tag === 'PageHeader') header = true;
        const target = imports.get(tag);
        if (target && drawsHeader(target)) header = true;
        const role = attribute(node, 'role')?.initializer;
        if (
          (role && ts.isStringLiteral(role) && role.text === 'alert') ||
          classesOf(node).includes('board-problem')
        ) {
          alert = true;
        }
      }
      if (ts.isJsxExpression(node) && node.expression && held.has(node.expression.getText())) {
        header = true;
      }
      ts.forEachChild(node, look);
    };
    look(jsx);
    if (alert && !header) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(jsx.getStart());
      problems.push(`${name(file)}:${line + 1}`);
    }
  };
  const walk = (node: ts.Node) => {
    if (node !== body && FUNCTION(node)) return;
    if (ts.isReturnStatement(node) && node.expression) check(node.expression);
    ts.forEachChild(node, walk);
  };
  walk(body);
  return problems;
}

const nonEmpty = (pairs: [string, string[]][]) =>
  new Map(pairs.filter(([, list]) => list.length > 0));

/**
 * The list must say exactly what is there: a file over its count names what is new; a file under it
 * means the entry can come down, which is how the list reaches nothing.
 */
function ratchet(found: Map<string, string[]>, listed: Ratchet): string[] {
  const problems: string[] = [];
  for (const file of new Set([...found.keys(), ...Object.keys(listed)])) {
    const items = found.get(file) ?? [];
    const allowed = listed[file] ?? 0;
    if (items.length > allowed) {
      problems.push(
        `${file}: ${items.length} found, ${allowed} listed; fix it, do not list it:\n  ${items.join('\n  ')}`,
      );
    } else if (items.length < allowed) {
      problems.push(`${file}: ${items.length} found, ${allowed} listed; lower the entry`);
    }
  }
  return problems;
}

const fromCss = (kind: Kind) =>
  nonEmpty(
    cssSources
      .filter(([file]) => name(file) !== 'styles/tokens.css')
      .map(([file, source]) => [name(file), cssProblems(source)[kind]]),
  );
const fromScripts = (pick: (f: JsxFacts) => string[]) =>
  nonEmpty(scripts.map((file) => [name(file), pick(factsOf(file))]));
/** Both, for a rule that holds in stylesheets and in scripts alike. */
const both = (kind: Kind, pick: (f: JsxFacts) => string[]) =>
  new Map([...fromCss(kind), ...fromScripts(pick)]);
/** Takes out what stays for good: an entry is a file and the one thing in it, so nothing new gets by. */
const minus = (found: Map<string, string[]>, named: Record<string, string>) =>
  nonEmpty(
    [...found].map(([file, items]) => [
      file,
      items.filter((item) => !(`${file} ${item}` in named)),
    ]),
  );

/**
 * What a page's header sits in: the shared page; or, on a page outside the shell, the stand-alone
 * page of `forms.css`, the Builder's, or the notice that this frontend cannot work with its server.
 */
const PAGE_ROOTS = new Set(['page', 'setup', 'builder', 'update-required']);

const none: StyledBy = { classes: new Set(), parentsOf: { button: new Set(), table: new Set() } };

describe('the design guard finds what it looks for (ADR-114)', () => {
  it('[NFR-005] reads a real set of stylesheets and components', () => {
    expect(stylesheets.length).toBeGreaterThan(20);
    expect(scripts.length).toBeGreaterThan(200);
    expect(routePages().size).toBeGreaterThan(40);
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    expect(cssDeclarations(tokens).some((d) => d.property === '--color-canvas')).toBe(true);
  });

  it('[NFR-005] finds a raw colour, and leaves a mask and a picture alone', () => {
    expect(cssProblems('a { color: #fff; }').rawColours).toHaveLength(1);
    expect(cssProblems('a { box-shadow: 0 0 0 rgb(0 0 0 / 10%); }').rawColours).toHaveLength(1);
    expect(cssProblems('a { mask: linear-gradient(#000 0 0); }').rawColours).toEqual([]);
    expect(cssProblems('a { background: url("x#fff.svg"); }').rawColours).toEqual([]);
    expect(cssProblems('a { color: var(--color-text); }').rawColours).toEqual([]);
    const script = jsxFacts('x.tsx', `const c = '#2f6fdb'; const r = '#/home';`, none);
    expect(script.rawColours).toEqual(['#2f6fdb']);
  });

  it('[NFR-005] finds an opaque surface on a panel, and leaves a field alone', () => {
    const on = (rule: string) => cssProblems(rule).opaqueSurfaces;
    expect(on('.panel { background: var(--color-surface-sunken); }')).toHaveLength(1);
    expect(on('.panel { background-color: var(--color-surface-raised); }')).toHaveLength(1);
    expect(on('.panel, input { background: var(--color-surface); }')).toHaveLength(1);
    expect(on('.form-field input { background: var(--color-surface-sunken); }')).toEqual([]);
    expect(on('.panel { color: var(--color-surface); }')).toEqual([]);
    expect(on('.panel { background: var(--glass-surface-sunken); }')).toEqual([]);
  });

  it('[NFR-005] finds a menu or a dialog left see-through (D3)', () => {
    const opaque =
      '.menu { background: var(--overlay-fill); backdrop-filter: none; -webkit-backdrop-filter: none; }';
    const glass = '.menu { background: var(--glass-fill-strong); backdrop-filter: blur(4px); }';
    expect(
      overlayProblems(
        [
          ['a.css', glass],
          ['b.css', opaque],
        ],
        ['.menu'],
      ),
    ).toEqual([]);
    expect(
      overlayProblems(
        [
          ['b.css', opaque],
          ['a.css', glass],
        ],
        ['.menu'],
      ),
    ).toHaveLength(2);
    const variant = '.menu.wide { background: var(--glass-fill-strong); }';
    expect(
      overlayProblems(
        [
          ['b.css', opaque],
          ['c.css', variant],
        ],
        ['.menu'],
      ),
    ).toHaveLength(1);
    const narrow = '@media (max-width: 1px) { .menu { backdrop-filter: blur(2px); } }';
    expect(
      overlayProblems(
        [
          ['b.css', opaque],
          ['c.css', narrow],
        ],
        ['.menu'],
      ),
    ).toHaveLength(1);
    const head = '.menu-head { background: var(--glass-fill-strong); }';
    expect(
      overlayProblems(
        [
          ['b.css', opaque],
          ['c.css', head],
        ],
        ['.menu'],
      ),
    ).toEqual([]);
    const card = '.card { background: var(--overlay-fill); }';
    expect(
      overlayProblems(
        [
          ['b.css', opaque],
          ['c.css', card],
        ],
        ['.menu'],
      ),
    ).toHaveLength(1);
  });

  it('[NFR-005] finds a check box drawn its own way (TR-24)', () => {
    const page: [string, string] = [
      'a.tsx',
      'export const A = () => <input type="checkbox" className="mine" />;',
    ];
    const own = '.mine { appearance: none; background: var(--glass-surface-sunken); }';
    expect(ownCheckBoxes([page], [['a.css', own]])).toHaveLength(2);
    expect(ownCheckBoxes([page], [['a.css', '.mine::before { mask: none; }']])).toHaveLength(1);
    expect(ownCheckBoxes([page], [['a.css', 'input:not(.mine) { appearance: none; }']])).toEqual(
      [],
    );
    // Its size and place are the page's own; a class on another element is not a check box.
    expect(ownCheckBoxes([page], [['a.css', '.mine { width: 28px; margin: 0; }']])).toEqual([]);
    const text: [string, string] = ['b.tsx', 'export const B = () => <input className="mine" />;'];
    expect(ownCheckBoxes([text], [['a.css', own]])).toEqual([]);
  });

  it('[NFR-005] finds a size that is not a token', () => {
    const on = (rule: string) => cssProblems(rule);
    expect(on('a { border-radius: 6px; }').radii).toHaveLength(1);
    expect(on('a { border-start-end-radius: 6px; }').radii).toHaveLength(1);
    expect(on('a { border-radius: var(--radius-1) 3px; }').radii).toHaveLength(1);
    expect(on('a { border-radius: var(--radius-pill); }').radii).toEqual([]);
    expect(on('a { border-radius: 50%; }').radii).toEqual([]);
    expect(on('a { font-size: 12px; }').fontSizes).toHaveLength(1);
    expect(on('a { font-size: 0.7rem; }').fontSizes).toHaveLength(1);
    expect(on('a { font: 600 12px serif; }').fontSizes).toHaveLength(1);
    expect(on('a { font-size: var(--font-size-200); }').fontSizes).toEqual([]);
    expect(on('a { font-size: 0.85em; }').fontSizes).toEqual([]);
    expect(on('a { font: inherit; }').fontSizes).toEqual([]);
    expect(on('a { font-weight: 650; }').fontWeights).toHaveLength(1);
    expect(on('a { font-weight: var(--font-weight-strong); }').fontWeights).toEqual([]);
    expect(on('a { border-radius: calc(var(--radius-4) * 1.5); }').radii).toEqual([]);
  });

  it('[NFR-005] reads JSX: titles, headers, glass, bare controls and bare empties', () => {
    const see = (code: string, by = none) => jsxFacts('x.tsx', code, by);
    expect(see('<h1 className="page-title">x</h1>').titles).toEqual(['h1']);
    expect(see('<h2 className="page-title">x</h2>').titles).toEqual(['h2']);
    const header = see('<PageHeader title="x" />');
    expect([header.pageHeaders, header.noPurpose]).toEqual([1, 1]);
    expect(see('<PageHeader title="x" purpose="y" />').noPurpose).toBe(0);
    expect(see('<button type="button">x</button>').bareButtons).toBe(1);
    expect(see('<button className="a">x</button>').bareButtons).toBe(0);
    expect(see('<table><tr /></table>').bareTables).toBe(1);
    const parented = styledBy(['.tools button { color: red; } .sheet > table { width: 1px; }']);
    expect(
      see('<div className="tools"><button type="button">x</button></div>', parented).bareButtons,
    ).toBe(0);
    expect(see('<div className="sheet"><table /></div>', parented).bareTables).toBe(0);
    expect(see('<fieldset className="modes" />').fieldsetClasses).toEqual(['modes']);
    expect(see(`<p className="page-note">{t('x.none')}</p>`).bareEmpties).toEqual(['x.none']);
    expect(see(`<p className="page-note">{t('x.title')}</p>`).bareEmpties).toEqual([]);
    // Under any class, or none, and over several lines.
    expect(see(`<p className="any">\n{t('x.empty', { a: 1 })}\n</p>`).bareEmpties).toEqual([
      'x.empty',
    ]);
    expect(see(`<li>{t('x.none')}</li>`).bareEmpties).toEqual(['x.none']);
    // A `noX` sentence is one too (T-222); a word that only starts with "no" is not.
    expect(see(`<p>{t('x.noTabs')}</p>`).bareEmpties).toEqual(['x.noTabs']);
    expect(see(`<p>{t('x.notes')}</p>`).bareEmpties).toEqual([]);
    // An EmptyState is the fix; a choice in a list and a link are not sentences.
    expect(see(`<div><EmptyState compact title={t('x.none')} /></div>`).bareEmpties).toEqual([]);
    expect(see(`<div><select><option>{t('x.none')}</option></select></div>`).bareEmpties).toEqual(
      [],
    );
    expect(see(`<p title={t('x.none')}>y</p>`).bareEmpties).toEqual([]);
    // The element around a header, through a fragment; one kept in a variable has none.
    expect(
      see('<section className="page x"><><PageHeader title="x" /></></section>').headerParents,
    ).toEqual([['page', 'x']]);
    expect(see('const h = <PageHeader title="x" />;').headerParents).toEqual([]);
    expect(
      see('<div className="glass-card"><p><i className="glass-card" /></p></div>').nestedGlass,
    ).toEqual(['i']);
    expect([...see('<div className="glass-card"><Panel /></div>').renderedInGlass]).toEqual([
      'Panel',
    ]);
    expect(see('<div style={{ fontSize: 12 }} />').literalSizes).toHaveLength(1);
  });

  it("[NFR-005] finds a mouse's height with no finger's beside it", () => {
    expect(selectorsOf('.a :is(b, c), .d  e')).toEqual(['.a :is(b, c)', '.d e']);
    const short = (css: string) => shortOnTouch([css]);
    expect(short('.a { min-height: var(--hit-target); }')).toEqual(['.a']);
    expect(
      short(`
        .a, .b { min-height: var(--hit-target); }
        @media (pointer: coarse) { .a { min-height: var(--hit-target-touch); } .b { height: 44px; } }
      `),
    ).toEqual([]);
    // A touch rule that asks for a mouse's height, and a finger's height that is no touch rule.
    expect(short('@media (pointer: coarse) { .a { min-height: var(--hit-target); } }')).toEqual([
      '.a',
    ]);
    expect(
      short('.a { min-height: var(--hit-target); } .a { min-height: var(--hit-target-touch); }'),
    ).toEqual(['.a']);
    // A finger's height on touch screens of some widths only, whichever way the query is written
    // (T-231); a query that holds on any touch screen is no gate.
    const mouse = '.a { min-height: var(--hit-target); }';
    const finger = '.a { min-height: var(--hit-target-touch); }';
    expect(short(`${mouse} @media (pointer: coarse) and (max-width: 767px) { ${finger} }`)).toEqual(
      ['.a'],
    );
    expect(
      short(`${mouse} @media (width < 768px) { @media (pointer: coarse) { ${finger} } }`),
    ).toEqual(['.a']);
    expect(
      short(`${mouse} @media (pointer: coarse) { @media (min-height: 30rem) { ${finger} } }`),
    ).toEqual(['.a']);
    expect(short(`${mouse} @media (max-width: 767px), (pointer: coarse) { ${finger} }`)).toEqual(
      [],
    );
  });

  it('[NFR-007] finds a grip that no touch check knows of (T-290)', () => {
    const grips = (css: string, listed: string[] = []) => unlistedGrips([css], listed);
    expect(grips('.a { cursor: grab; touch-action: none; }')).toEqual(['.a']);
    expect(grips('.a { cursor: grab; touch-action: none; }', ['.a'])).toEqual([]);
    // Read across rules, at-rules and sheets, as the browser puts them together.
    expect(
      unlistedGrips(
        ['.a { cursor: grab; }', '@media (pointer: coarse) { .a { touch-action: none; } }'],
        [],
      ),
    ).toEqual(['.a']);
    // Every hand that says "drag me", behind its fallbacks too.
    for (const cursor of ['grabbing', '-webkit-grab', 'move', 'url(hand.svg) 4 4, grab']) {
      expect(grips(`.a { cursor: ${cursor}; touch-action: none; }`)).toEqual(['.a']);
    }
    // One without the other is no grip: a row a mouse drags, a canvas a finger pans.
    expect(
      grips(
        '.a { cursor: grab; } .b { touch-action: none; } .c { touch-action: pan-y; cursor: grab; }',
      ),
    ).toEqual([]);
    // A listed grip in a place of its own or in a state is the same grip; a longer name is not.
    expect(
      grips('.row .a:hover, .a.big { cursor: grabbing; touch-action: none; }', ['.a']),
    ).toEqual([]);
    expect(grips('.a-wide, .b { cursor: grab; touch-action: none; }', ['.a'])).toEqual([
      '.a-wide',
      '.b',
    ]);
  });

  it('[NFR-007] holds what is dragged whole to a story on a real touch screen (T-290)', () => {
    const story = (name: string) =>
      touchStoryProblem(SRC, `timeline/TimelinePage.stories.tsx#${name}`);
    expect(story('ThinBarOnATouchScreen')).toBeUndefined();
    // A story that runs under a mouse, a story that is not there, a file that is not a story file.
    expect(story('Timeline')).toContain('does not run on a real touch screen');
    expect(story('ThinBar')).toContain('exports no ThinBar');
    expect(touchStoryProblem(SRC, 'timeline/TimelinePage.tsx#TimelinePage')).toContain(
      'is not a story file',
    );
    expect(touchStoryProblem(SRC, 'the side panel')).toContain('is not file#Story');
  });

  it('[NFR-005] holds a list to what is there, in both directions', () => {
    const found = new Map([['a.css', ['one', 'two']]]);
    expect(ratchet(found, { 'a.css': 2 })).toEqual([]);
    expect(ratchet(found, { 'a.css': 1 })[0]).toContain('2 found, 1 listed');
    expect(ratchet(found, { 'a.css': 3 })[0]).toContain('lower the entry');
    expect(ratchet(new Map(), { 'a.css': 1 })[0]).toContain('lower the entry');
  });
});

describe('the app reads as one design (ADR-114, T-144)', () => {
  it('[NFR-005] has no raw colours outside the tokens', () => {
    const found = minus(
      both('rawColours', (f) => f.rawColours),
      ALLOWED.rawColours,
    );
    expect(ratchet(found, OFFENDERS.rawColours)).toEqual([]);
  });

  it('[NFR-005] keeps opaque surface tokens to fields and named reasons', () => {
    const found = both('opaqueSurfaces', (f) => f.opaqueSurfaces);
    expect(ratchet(found, OFFENDERS.opaqueSurfaces)).toEqual([]);
  });

  it('[NFR-005] draws menus, the command palette and dialogs opaque (D3, T-220)', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    const order = [...main.matchAll(/import '\.\/(styles\/[\w-]+\.css)'/g)].map((m) => m[1]);
    expect(order.length).toBeGreaterThan(20);
    const rank = (file: string) => {
      const at = order.indexOf(name(file));
      return at < 0 ? order.length : at;
    };
    const sheets = [...cssSources]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([file, source]) => [name(file), source] as const);
    expect(overlayProblems(sheets)).toEqual([]);
  });

  it('[NFR-005] draws every check box and radio one way, from forms.css (TR-24, AC-11)', () => {
    const pages = scripts.map((file) => [file, readFileSync(file, 'utf8')] as const);
    const sheets = cssSources.map(([file, source]) => [name(file), source] as const);
    expect(ownCheckBoxes(pages, sheets)).toEqual([]);
  });

  it('[NFR-005] draws links in the accent, in both skins (ADR-036)', () => {
    const shell = cssSources.find(([file]) => name(file) === 'styles/shell.css')?.[1] ?? '';
    const links = cssDeclarations(shell).filter(
      (d) => d.selector === 'a' && d.property === 'color',
    );
    expect(links.map((d) => d.value)).toEqual(['var(--color-accent)']);
  });

  it("[NFR-005] gives every mouse-sized target a finger's height on touch (ADR-033)", () => {
    expect(shortOnTouch(cssSources.map(([, source]) => source))).toEqual([]);
  });

  it('[NFR-007] lists every grip for the touch checks, or why it is dragged whole (T-290)', () => {
    const sources = cssSources.map(([, source]) => source);
    expect(unlistedGrips(sources, [...GRIP_SELECTORS, ...Object.keys(DRAGGED_WHOLE)])).toEqual([]);
    // What is let through is still there to let through, each with its reason.
    expect(unlistedGrips(sources, GRIP_SELECTORS)).toEqual(Object.keys(DRAGGED_WHOLE).sort());
    // Each says why, and names the story that checks its finger's size on a real touch screen.
    for (const [grip, { reason, checkedBy }] of Object.entries(DRAGGED_WHOLE)) {
      expect(reason.length, grip).toBeGreaterThan(20);
      expect(touchStoryProblem(SRC, checkedBy), grip).toBeUndefined();
    }
  });

  it('[NFR-005] lifts an edge fade while something in the strip has focus (TR-4)', () => {
    // Any focus in it, or (Account's sections, whose link keeps focus after a tap) keyboard focus,
    // or (the command palette, whose focus stays in its search field) an active option moved on.
    const lifted =
      /:not\(:focus-within\)|:not\(:has\(:focus-visible\)\)|:not\(:has\(\[aria-selected="true"\]/;
    const fades = cssSources.flatMap(([file, source]) =>
      cssDeclarations(source)
        .filter((d) => /^(-webkit-)?mask(-image)?$/.test(d.property))
        .filter((d) => d.selector.includes('[data-more'))
        .filter((d) => !lifted.test(d.selector))
        .map((d) => `${name(file)} ${d.selector}`),
    );
    expect(fades).toEqual([]);
  });

  it('[NFR-005] takes radii from the tokens', () => {
    expect(ratchet(fromCss('radii'), {})).toEqual([]);
  });

  it('[NFR-005] takes font sizes from the tokens', () => {
    expect(
      ratchet(
        both('fontSizes', (f) => f.literalSizes),
        {},
      ),
    ).toEqual([]);
  });

  it('[NFR-005] takes font weights from the tokens', () => {
    expect(ratchet(fromCss('fontWeights'), {})).toEqual([]);
  });

  it('[NFR-005] draws a page title only in PageHeader', () => {
    const found = minus(
      fromScripts((f) => f.titles),
      ALLOWED.titles,
    );
    expect(ratchet(found, OFFENDERS.titles)).toEqual([]);
  });

  it('[NFR-005] gives every route page a PageHeader', () => {
    const missing = [...routePages()]
      .filter(([, file]) => !drawsHeader(file))
      .map(([component]) => component)
      .filter((component) => !(component in ALLOWED.pagesWithoutHeader))
      .sort();
    expect(missing).toEqual([...OFFENDERS.pagesWithoutHeader].sort());
  });

  it("[NFR-005] keeps a route page's header when it fails (UI-T22)", () => {
    const found = [...routePages()].flatMap(([component, file]) =>
      failuresWithoutHeader(file, component),
    );
    expect(found).toEqual([]);
  });

  it('[NFR-005] puts a page header in the shared page, for its width and rhythm', () => {
    const found = fromScripts((f) =>
      f.headerParents
        .filter((classes) => !classes.some((c) => PAGE_ROOTS.has(c)))
        .map((classes) => `<PageHeader> in "${classes.join(' ')}"`),
    );
    expect(ratchet(found, {})).toEqual([]);
    // One kept in a variable has no element around it to read: its file still has to have one.
    const heldApart = scripts.filter((file) => {
      const f = factsOf(file);
      return (
        f.pageHeaders > f.headerParents.length && ![...f.allClasses].some((c) => PAGE_ROOTS.has(c))
      );
    });
    expect(heldApart.map(name)).toEqual([]);
  });

  it('[NFR-005] keeps a glass card out of a glass card (ADR-114)', () => {
    const inside = (file: string, seen = new Set<string>()): boolean => {
      if (seen.has(file) || !facts.has(file)) return false;
      seen.add(file);
      if (factsOf(file).allClasses.has('glass-card')) return true;
      const imports = importsOf(file, readFileSync(file, 'utf8'));
      return [...factsOf(file).rendered].some((tag) => {
        const target = imports.get(tag);
        return target !== undefined && inside(target, seen);
      });
    };
    const found = fromScripts((f) => f.nestedGlass.map((tag) => `<${tag}> in a glass-card`));
    expect(ratchet(found, {})).toEqual([]);
    const across = scripts.flatMap((file) => {
      const imports = importsOf(file, readFileSync(file, 'utf8'));
      return [...factsOf(file).renderedInGlass]
        .filter((tag) => {
          const target = imports.get(tag);
          return target !== undefined && inside(target);
        })
        .map((tag) => `${name(file)} ${tag}`);
    });
    expect(across.filter((item) => !(item in ALLOWED.glassInGlass))).toEqual([]);
  });

  it('[NFR-005] gives every PageHeader a purpose line', () => {
    const found = fromScripts((f) =>
      Array.from({ length: f.noPurpose }, () => '<PageHeader> with no purpose'),
    );
    expect(ratchet(found, OFFENDERS.noPurpose)).toEqual([]);
  });

  it('[NFR-005] leaves no button or table without a style', () => {
    const found = fromScripts((f) => [
      ...Array.from({ length: f.bareButtons }, () => '<button> with no class or parent rule'),
      ...Array.from({ length: f.bareTables }, () => '<table> with no class or parent rule'),
    ]);
    expect(ratchet(found, OFFENDERS.bareControls)).toEqual([]);
  });

  it('[NFR-005] gives every fieldset class a rule', () => {
    const found = fromScripts((f) => f.fieldsetClasses.filter((c) => !styled.classes.has(c)));
    expect(ratchet(found, OFFENDERS.fieldsetsWithoutRule)).toEqual([]);
  });

  it('[NFR-005] says "none yet" with an EmptyState, not a bare note', () => {
    const found = minus(
      fromScripts((f) => f.bareEmpties),
      ALLOWED.bareEmpties,
    );
    expect(ratchet(found, OFFENDERS.bareEmpties)).toEqual([]);
  });

  it('[NFR-005] gives a reason for each thing it lets through for good', () => {
    for (const list of Object.values(ALLOWED)) {
      for (const reason of Object.values(list)) expect(reason).toMatch(/\S{3}/);
    }
  });
});

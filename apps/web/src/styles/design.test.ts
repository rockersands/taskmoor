import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * opaque overlay fill with no blur (D3); links in the accent; a finger's height on touch wherever a
 * mouse's is set, and for every target given a fixed height under a finger's (T-294); every grip,
 * in a stylesheet or styled in a script, known to the touch checks (T-290, T-294); radii, font sizes and font weights only from the tokens; one level-one heading, from PageHeader;
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
 * - A control whose height comes from its words, padding or place rather than a fixed height, a
 *   class put on a control built at runtime, a touch rule under another selector whose reach the
 *   source cannot tell (a state, a sibling, an element around it past a component, which may draw
 *   it elsewhere, or around a component drawn in ways the source does not show), a press area drawn
 *   by `::after` that is placed elsewhere: the touch stories, which measure what they cover, and the
 *   sweep's probe (T-296). A class put on a control through a component of ours that passes its
 *   className on (`<Link className>`), and a touch rule under another selector that surely reaches
 *   every element a short rule may size, it does see (T-298); so too a class beside a template's
 *   placeholder that is only ever a space-led word or nothing, the cascade's order between rules of
 *   equal weight (the stylesheets as main.tsx loads them), and the elements around a component in
 *   the files that draw it (T-353). An element whose className is built at runtime is held as one
 *   a short rule may size whenever the words of the scripts could make the class, so it is no cover
 *   for one it cannot see. A class that comes only from data, or one `classList` adds, it cannot see.
 *   A later reset that takes a touch rule's finger's height away (`min-height: auto`) it sees on
 *   the elements it may reach by what is written on them (T-356); one that meets a short rule only
 *   on a class the runtime might build, a reset of the touch rule that answers a reset, and a
 *   `max-height` that caps a finger's height, it does not: the touch stories and the probe.
 * - A glass card in a component drawn inside one, through a component given the inner card as its
 *   children or a helper imported from another file: the Chrome pass. It reads what each component
 *   draws (T-356), a class it writes on a component of ours among it, and JSX outside every
 *   component as any of its file's.
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
    // Forward slashes on any system, so paths match the imports resolved below (T-313).
    const path = join(dir, entry.name).replaceAll('\\', '/');
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
const FINGER_PX = 44;
/** What sets a box's height, written either way. */
const HEIGHT = /^(min-)?(height|block-size)$/;

/**
 * Custom properties the stylesheets set to a fixed length outside any at-rule (`--hit-target`,
 * `--space-3`), in pixels, so a height written with one reads as the length it is.
 */
function fixedSizes(declarations: Declaration[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const d of declarations) {
    if (!d.property.startsWith('--') || d.atRules.length > 0 || sizes.has(d.property)) continue;
    const px = pixels(d.value, new Map());
    if (px !== undefined) sizes.set(d.property, px);
  }
  return sizes;
}

/**
 * A length in pixels when it is fixed: px, rem and em (at the 16 px the app is set in), or a custom
 * property of `sizes`. Undefined for anything that grows with what is around it: a percentage, a
 * calc(), auto, a viewport unit.
 */
function pixels(value: string, sizes: Map<string, number>): number | undefined {
  const plain = value.replace(/\s*!important$/, '').trim();
  const token = /^var\((--[\w-]+)\)$/.exec(plain);
  if (token) return sizes.get(token[1] as string);
  const length = /^(\d*\.?\d+)(px|r?em)$/.exec(plain);
  if (!length) return plain === '0' ? 0 : undefined;
  return Number(length[1]) * (length[2] === 'px' ? 1 : 16);
}

/** The last compound of a selector, the element it styles, with a comma or space in `:is()` kept. */
export function subjectOf(part: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part[i] as string;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(c)) start = i + 1;
  }
  return part.slice(start);
}

/** The class names a compound selector asks for itself, leaving out what `:not()` and `:has()` ask. */
const classesIn = (compound: string) =>
  Array.from(
    compound
      .replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '')
      .matchAll(/\.(-?[_a-zA-Z][\w-]*)/g),
    (m) => m[1] as string,
  );

/** Elements a finger presses by their nature, and the roles that make any element one. */
const CONTROL_TAG = /(?:^|[\s(,])(?:button|a|input|select|textarea|summary)(?![\w-])/;
const CONTROL_ROLE =
  /^(?:button|link|tab|checkbox|radio|switch|menuitem(?:checkbox|radio)?|option|slider|spinbutton|combobox|treeitem)$/;
const ROLE_SELECTOR =
  /\[role=["']?(?:button|link|tab|checkbox|radio|switch|menuitem\w*|option|slider)["']?\]/;

/**
 * Whether a selector styles something a finger presses (T-294): a button, link, field or summary;
 * an element given a control's role; a class written on one of those in the app's components
 * (`controls`, from `jsxFacts`); or a grip or what is dragged whole (`grips`, class names). A
 * pseudo-element is drawn, never pressed, so `.x::before` is no target, whatever `.x` is.
 */
export function isTargetSelector(
  part: string,
  controls: ReadonlySet<string>,
  grips: ReadonlySet<string>,
): boolean {
  const subject = subjectOf(part);
  if (subject.includes('::')) return false;
  const own = subject.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '');
  if (CONTROL_TAG.test(own.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'/g, '')) || ROLE_SELECTOR.test(own)) {
    return true;
  }
  return classesIn(own).some((c) => controls.has(c) || grips.has(c));
}

/* ------------------------------ selectors held against JSX ------------------------------ */

/** An element as a component's JSX writes it: what a selector can be held against (T-298). */
export interface JsxNode {
  tag: string;
  /** The classes surely on it: written whole as literals, outside any condition. */
  classes: string[];
  /** Classes written as literals that only a condition puts on it (`on ? 'is-on' : ''`). */
  maybe: string[];
  /**
   * Its className has a part built at runtime (a name, a call, a word glued to `${}`) or a spread
   * may set it: it may hold classes no one can read here (`mayCarry`).
   */
  built: boolean;
  /** Attributes written as a string literal; null for one whose value is an expression. */
  attrs: Record<string, string | null>;
  /** A spread may add attributes no one can read here. */
  open: boolean;
}

/**
 * The words of the app's scripts a class built at runtime could be made of (T-298): every word of
 * a string outside a native element's own className (a variable, a prop, a component's className),
 * and the pieces of a template glued to a `${}`, as the start or end of a class.
 */
export interface LooseClasses {
  whole: Set<string>;
  prefixes: Set<string>;
  suffixes: Set<string>;
}

/** Whether a class could be on an element whose className is built at runtime. */
export type MayCarry = (cls: string) => boolean;
const anything: MayCarry = () => true;

/** `MayCarry` from the loose words of every script; without any, every class may be carried. */
export function mayCarryFrom(loose: readonly LooseClasses[]): MayCarry {
  const whole = new Set(loose.flatMap((l) => [...l.whole]));
  const prefixes = [...new Set(loose.flatMap((l) => [...l.prefixes]))];
  const suffixes = [...new Set(loose.flatMap((l) => [...l.suffixes]))];
  return (cls) =>
    whole.has(cls) ||
    prefixes.some((p) => cls.startsWith(p)) ||
    suffixes.some((s) => cls.endsWith(s));
}

/** A component's place among the elements around one: what it draws, and where, is unknown. */
const isBoundary = (node: JsxNode) => /^[A-Z]/.test(node.tag) || node.tag.includes('.');

/** An element drawn by the app's JSX, with the elements around it in its file, nearest first. */
export interface JsxElementFact extends JsxNode {
  around: JsxNode[];
  /**
   * The component of its file whose returned JSX it is part of, with no function, variable or call
   * between (T-353): where that component is drawn, so is it. Undefined when it is not one's.
   */
  root?: string | undefined;
  /** The component it is drawn by, as `ownerIn` reads it (T-356). */
  owner?: string | undefined;
  /**
   * The elements around each place its `root` is drawn, in the files that draw it, nearest first,
   * one list per place (`elementsInPlace`); a selector must reach it in every one. Unknown places
   * leave it with only what is around it in its file.
   */
  outside?: JsxNode[][];
}

/** Three-valued: true, false, or undefined when the source cannot tell (a state, a sibling). */
type Maybe = boolean | undefined;
const all = (values: Maybe[]): Maybe =>
  values.includes(false) ? false : values.includes(undefined) ? undefined : true;
const any = (values: Maybe[]): Maybe =>
  values.includes(true) ? true : values.includes(undefined) ? undefined : false;

/** A compound selector's simple parts: `button`, `.a`, `[type="x"]`, `:not(.b)`, `::after`. */
function simplesOf(compound: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < compound.length) {
    let end = i + 1;
    if (compound[i] === '[') {
      let quote = '';
      while (end < compound.length && (quote || compound[end - 1] !== ']')) {
        const c = compound[end] as string;
        if (quote) quote = c === quote ? '' : quote;
        else if (c === '"' || c === "'") quote = c;
        end++;
      }
    } else {
      if (compound.startsWith('::', i)) end = i + 2;
      while (end < compound.length && /[\w-]/.test(compound[end] as string)) end++;
      if (compound[end] === '(') {
        let depth = 0;
        do {
          if (compound[end] === '(') depth++;
          if (compound[end] === ')') depth--;
          end++;
        } while (end < compound.length && depth > 0);
      }
    }
    parts.push(compound.slice(i, end));
    i = end;
  }
  return parts;
}

/** A complex selector's compounds and the combinators between them, left to right. */
function compoundsOf(part: string): { compounds: string[]; combinators: string[] } {
  const compounds: string[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let current = '';
  let pending = '';
  for (const c of part) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(c)) {
      if (current) {
        compounds.push(current);
        current = '';
        pending = ' ';
      }
      if (c !== ' ' && /\S/.test(c)) pending = c;
      continue;
    }
    if (!current && compounds.length > 0) combinators.push(pending);
    current += c;
  }
  if (current) compounds.push(current);
  return { compounds, combinators };
}

/**
 * Whether `node` matches a simple selector, as far as its source can tell: a state (`:hover`,
 * `:checked`), a place among siblings (`:first-child`) or what is inside (`:has()`) it cannot.
 */
function matchSimple(simple: string, node: JsxNode, carry: MayCarry = anything): Maybe {
  if (simple === '*') return true;
  if (/^[a-zA-Z]/.test(simple)) return node.tag.toLowerCase() === simple.toLowerCase();
  if (simple.startsWith('.')) {
    const cls = simple.slice(1);
    if (node.classes.includes(cls)) return true;
    if (node.maybe.includes(cls) || (node.built && carry(cls))) return undefined;
    return false;
  }
  if (simple.startsWith('#')) return matchSimple(`[id="${simple.slice(1)}"]`, node, carry);
  if (simple.startsWith('[')) {
    const m =
      /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?)?\s*\]$/.exec(
        simple,
      );
    if (!m) return undefined;
    const [, written = '', op, dq, sq, bare, flag] = m;
    const attr = written.toLowerCase();
    if (!(attr in node.attrs)) return node.open ? undefined : false;
    const value = node.attrs[attr];
    if (value === null || value === undefined) return op ? undefined : true;
    if (!op) return true;
    const fold = (s: string) => (flag ? s.toLowerCase() : s);
    const [has, want] = [fold(value), fold(dq ?? sq ?? bare ?? '')];
    if (op === '=') return has === want;
    if (op === '~=') return has.split(/\s+/).includes(want);
    if (op === '|=') return has === want || has.startsWith(`${want}-`);
    if (op === '^=') return has.startsWith(want);
    if (op === '$=') return has.endsWith(want);
    return has.includes(want);
  }
  const fn = /^:([\w-]+)\((.*)\)$/s.exec(simple);
  if (fn) {
    const [, name, args = ''] = fn;
    // An argument with a combinator asks about other elements: the source cannot tell.
    const each = selectorsOf(args).map((arg) =>
      compoundsOf(arg).compounds.length === 1 ? matchCompound(arg, node, carry) : undefined,
    );
    if (name === 'not') {
      const hit = any(each);
      return hit === undefined ? undefined : !hit;
    }
    if (name === 'is' || name === 'where' || name === 'matches') return any(each);
    return undefined;
  }
  if (/^:(?:any-)?link$/.test(simple)) return node.tag === 'a' && 'href' in node.attrs;
  if (simple === ':root' || simple === ':scope') return false;
  return undefined;
}

function matchCompound(compound: string, node: JsxNode, carry: MayCarry = anything): Maybe {
  return all(simplesOf(compound).map((simple) => matchSimple(simple, node, carry)));
}

/**
 * Whether a selector surely reaches an element of the app's JSX (T-298): its last compound matches
 * the element and the others the elements around it in its file and then, in every place its
 * component is drawn, around that (`outside`, T-353), by the classes surely on them and their
 * literal attributes. What the source cannot tell (a state such as `:hover`, a sibling, a class
 * only a condition or the runtime puts there, an ancestor where a component is drawn unseen) is
 * taken as not reached, so a touch rule is only credited where it surely applies. A component
 * between them is an ancestor no one knows: it may draw its children anywhere, even elsewhere in
 * the page (a portal, as OverlayLayer does), so a selector reaches past one to nothing. A trailing
 * `::before` or `::after` reaches the element it is drawn on.
 */
export function surelyReaches(
  part: string,
  element: JsxElementFact,
  carry: MayCarry = anything,
): boolean {
  const { compounds, combinators } = compoundsOf(part.replace(/::(?:before|after)$/, ''));
  if (compounds.some((c) => c.includes('::'))) return false;
  const last = compounds.length - 1;
  if (matchCompound(compounds[last] as string, element, carry) !== true) return false;
  const matches = (i: number, node: JsxNode | undefined) =>
    node !== undefined &&
    !isBoundary(node) &&
    matchCompound(compounds[i] as string, node, carry) === true;
  // In every place it is drawn (T-353): what is around it in its file, then around its component.
  const places = element.outside?.length ? element.outside : [[]];
  return places.every((place) => {
    const around = [...element.around, ...place];
    // Compound i at element `at` of `around`, and the ones before it further out.
    const from = (i: number, at: number): boolean => {
      if (i < 0) return true;
      const combinator = combinators[i];
      if (combinator === '>') return matches(i, around[at]) && from(i - 1, at + 1);
      if (combinator !== ' ') return false;
      for (let j = at; j < around.length; j++) {
        if (isBoundary(around[j] as JsxNode)) return false;
        if (matches(i, around[j]) && from(i - 1, j + 1)) return true;
      }
      return false;
    };
    return from(last - 1, 0);
  });
}

/**
 * Whether a selector may reach an element: its last compound does not surely miss it. What is
 * around it is not asked, since a component may be drawn inside anything; so this errs towards
 * reaching, as the elements a short rule sizes should. An element whose className is built at
 * runtime may hold any class `carry` allows.
 */
export function mayReach(part: string, element: JsxNode, carry: MayCarry = anything): boolean {
  const { compounds } = compoundsOf(part);
  return matchCompound(compounds.at(-1) ?? '', element, carry) !== false;
}

/** Whether a class could be on an element whose className is built at runtime: never. */
const onlyWritten: MayCarry = () => false;

/**
 * Whether a selector may reach an element by what its source writes on it (T-356), for a rule that
 * may take a finger's height away: its last compound does not surely miss it by its tag, its
 * attributes and the classes written on it, surely or under a condition, and a parent it asks for
 * with `>` is not surely another, where the element's parent is in its file. A class only the
 * runtime could build is not counted: nearly any class could be, and no touch rule would stand.
 */
export function mayUndo(part: string, element: JsxElementFact): boolean {
  const { compounds, combinators } = compoundsOf(part.replace(/::(?:before|after)$/, ''));
  if (matchCompound(compounds.at(-1) ?? '', element, onlyWritten) === false) return false;
  const parent = element.around[0];
  return !(
    combinators.at(-1) === '>' &&
    parent !== undefined &&
    !isBoundary(parent) &&
    matchCompound(compounds.at(-2) ?? '', parent, onlyWritten) === false
  );
}

/** A selector's specificity: ids, then classes, attributes and pseudo-classes, then tags. */
export function specificity(part: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  const add = (s: [number, number, number]) => {
    for (const i of [0, 1, 2] as const) total[i] += s[i];
  };
  for (const compound of compoundsOf(part).compounds) {
    for (const simple of simplesOf(compound)) {
      const fn = /^:([\w-]+)\((.*)\)$/s.exec(simple);
      if (simple === '*') continue;
      if (simple.startsWith('::') || /^[a-zA-Z]/.test(simple)) add([0, 0, 1]);
      else if (simple.startsWith('#')) add([1, 0, 0]);
      else if (fn && fn[1] === 'where') continue;
      else if (fn && /^(?:is|not|has|matches)$/.test(fn[1] as string)) {
        const most = selectorsOf(fn[2] ?? '')
          .map(specificity)
          .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
        if (most) add(most);
      } else add([0, 1, 0]);
    }
  }
  return total;
}

const beats = (a: string, b: string) => {
  const [x, y] = [specificity(a), specificity(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/**
 * Selectors with less than a finger's height that no `(pointer: coarse)` rule gives a finger's: the
 * height a touch screen needs is one line away in the same stylesheets (ADR-033). Two kinds:
 * - anything sized with `var(--hit-target)`, a mouse's height by name;
 * - a target (`isTarget`, see `isTargetSelector`) given a fixed height under 44 px, however it is
 *   written (`24px`, `1.5rem`, `var(--space-6)`), which once let the timeline bar's 24 px through
 *   with every test green (T-294). A height of 1 px or none hides a control, it does not size it.
 * A touch rule that asks for less is the same mistake. A touch rule that gives the selector's
 * `::before` or `::after` a finger's height counts as the finger's: a press area drawn over the
 * control, so it can keep its look (T-293). A touch rule counts only where it wins (T-353): a press
 * area, a min-height over a height, a finger's height over a short min-height, and between two of
 * one kind the cascade: `!important`, then specificity, then the later rule, `sources` being in the
 * order the app loads them. So a short rule of equal weight after a touch rule undoes it.
 *
 * Nor does a touch rule count where another rule that may hold on a touch screen (under no query
 * for print or a fine pointer only) wins over it in the cascade and sets the same kind of height to
 * anything short of a finger's (T-356): a reset such as `min-height: auto` or `min-height: 0` after
 * a finger's floor, or `height: auto` after a finger's height over a short min-height, takes the
 * finger's height away again, though it sizes nothing short itself. It counts where it reaches the
 * same element: under the touch rule's own selector, or on an element the short rule may size that
 * it may reach by what the source writes on it (`mayUndo`). A short rule is no reset, since it
 * answers for itself, nor is one that a touch rule under its own selector answers.
 *
 * A touch rule under another selector counts too when it reaches every element of `elements` (the
 * app's JSX, `jsxFacts`, placed by `elementsInPlace`) that the short selector may reach, and wins
 * there (T-298). One whose reach the source cannot tell (a state, a sibling, an ancestor past a
 * component or where a component is drawn in more ways than the source shows) is no cover. An
 * element whose className is built at runtime may hold any class that `carry` allows
 * (`mayCarryFrom`, every class without it), so a short rule may size it too, and the cover must
 * surely reach it as well.
 */
export function shortOnTouch(
  sources: string[],
  isTarget: (selector: string) => boolean = () => false,
  elements: readonly JsxElementFact[] = [],
  carry: MayCarry = anything,
): string[] {
  // In the order the browser reads them: a later declaration of equal weight wins (T-353).
  const declarations = sources.flatMap(cssDeclarations);
  const sizes = fixedSizes(declarations);
  const sized = declarations
    .map((d, order) => ({ ...d, order, important: /!important\s*$/.test(d.value) }))
    .filter((d) => HEIGHT.test(d.property));
  const isFinger = (d: Declaration) =>
    FINGER.test(d.value) || (pixels(d.value, sizes) ?? 0) >= FINGER_PX;
  /** Each selector of a rule apart, with the press area it draws (`::before`, `::after`) aside. */
  const apart = <D extends Declaration>(d: D) =>
    selectorsOf(d.selector).map((part) => {
      const pseudo = /::(?:before|after)$/.exec(part)?.[0] ?? '';
      return {
        ...d,
        written: part,
        part: part.slice(0, part.length - pseudo.length),
        pseudo,
        pressArea: pseudo !== '',
      };
    });
  const fingerRules = sized.filter((d) => isTouchRule(d) && isFinger(d)).flatMap(apart);
  const short = sized.flatMap((d) => {
    const parts = selectorsOf(d.selector);
    const found = (list: string[]) => list.map((part) => ({ ...d, part }));
    if (d.value === 'var(--hit-target)') return found(parts);
    const px = pixels(d.value, sizes);
    if (px === undefined || px <= 1 || px >= FINGER_PX) return [];
    return found(parts.filter(isTarget));
  });
  type Sized = { part: string; property: string; order: number; important: boolean };
  type Apart = Sized & { pseudo: string; pressArea: boolean };
  /** The cascade between two rules for one element: `!important`, specificity, then order. */
  const wins = (a: Sized, b: Sized) => {
    if (a.important !== b.important) return a.important;
    const by = beats(a.part, b.part);
    return by > 0 || (by === 0 && a.order > b.order);
  };
  /**
   * Whether a finger's rule gives a finger's height where a short rule also applies (T-353): a
   * press area is drawn over the control whatever sizes it; a min-height is a floor under any
   * height, and a height of a finger's lifts a short min-height; between two of the same kind the
   * cascade decides: `!important`, then the more specific selector, then the later one.
   */
  const outweighs = (f: Apart, s: Sized) =>
    f.pressArea || isMin(f.property) !== isMin(s.property) || wins(f, s);
  // What may take a finger's height away again (T-356): anything short of one that may hold on a
  // touch screen, but the short rules themselves, which answer for every element they may reach,
  // and a reset that a touch rule under its own selector answers where it holds, with a floor
  // under its height, a height over its floor, or the same kind that wins.
  const shortOnes = new Set(short.map((s) => `${s.order} ${s.part}`));
  const resets = sized
    .filter((d) => !isFinger(d) && mayHoldOnTouch(d))
    .flatMap(apart)
    .filter((u) => !shortOnes.has(`${u.order} ${u.written}`))
    .filter(
      (u) =>
        !fingerRules.some(
          (g) =>
            g.part === u.part &&
            g.pseudo === u.pseudo &&
            (isMin(g.property) !== isMin(u.property) || wins(g, u)),
        ),
    );
  /** The resets that win over a finger's rule and set its kind of height on what it draws. */
  const undoers = new Map<Apart, Apart[]>(
    fingerRules.map((f) => [
      f,
      resets.filter(
        (u) => u.pseudo === f.pseudo && isMin(u.property) === isMin(f.property) && wins(u, f),
      ),
    ]),
  );
  /**
   * Whether a finger's rule still gives a finger's height where its own selector does and, when
   * given, on `element`: one the short rule may size by what its source writes, since a reset that
   * meets a short rule only on a class the runtime might build is guesswork twice over.
   */
  const stands = (f: Apart, element?: JsxElementFact) =>
    !(undoers.get(f) ?? []).some(
      (u) => u.part === f.part || (element !== undefined && mayUndo(u.part, element)),
    );
  /**
   * Whether touch rules give every element this rule may size a finger's, under its own selector or
   * another that surely reaches the element, and win there; with no such element in the source, its
   * own selector only.
   */
  const covered = (s: Sized) => {
    const reached = elements.filter((element) => mayReach(s.part, element, carry));
    if (reached.length === 0) {
      return fingerRules.some((f) => f.part === s.part && outweighs(f, s) && stands(f));
    }
    return reached.every((element) =>
      fingerRules.some(
        (f) =>
          (f.part === s.part || surelyReaches(f.part, element, carry)) &&
          outweighs(f, s) &&
          stands(f, mayReach(s.part, element, onlyWritten) ? element : undefined),
      ),
    );
  };
  const left = short.filter((s) => !covered(s));
  return [...new Set(left.map(({ part }) => part))].sort();
}

/** A floor (min-height, min-block-size) rather than a height. */
const isMin = (property: string) => property.startsWith('min-');

/** A media query that holds on no touch screen: each alternative asks for print or a mouse. */
const neverOnTouch = (at: string) =>
  at.startsWith('@media') &&
  at
    .slice('@media'.length)
    .split(',')
    .every((query) => /^\s*(?:only\s+)?print\b|pointer:\s*fine/.test(query));
/** A rule that may hold on a touch screen: under no at-rule that rules every touch screen out. */
const mayHoldOnTouch = (d: Declaration) => !d.atRules.some(neverOnTouch);

/** A cursor that says "drag me": a grab, a grabbing hand or a move, whatever its fallbacks. */
const GRAB_CURSOR = /^(?:-webkit-|-moz-)?(?:grab|grabbing|move)(?:\s*!important)?$/;
const isGrabCursor = (value: string) =>
  value
    .toLowerCase()
    .split(',')
    .some((v) => GRAB_CURSOR.test(v.trim()));
const PINNED = /^none\b/;

/**
 * Every grip of the stylesheets (T-290): a selector with both `touch-action: none` and a grab
 * cursor, read across all the sheets and their at-rules, without its trailing states, so a grip's
 * `:hover` is the grip.
 */
export function cssGrips(sources: string[]): string[] {
  const element = (part: string) => part.replace(/(?::{1,2}[\w-]+(?:\([^)]*\))?)+$/, '');
  const pinned = new Set<string>();
  const grabbed = new Set<string>();
  for (const d of sources.flatMap(cssDeclarations)) {
    const parts = selectorsOf(d.selector).map(element);
    if (d.property === 'touch-action' && PINNED.test(d.value.toLowerCase())) {
      for (const part of parts) pinned.add(part);
    }
    if (d.property === 'cursor' && isGrabCursor(d.value)) {
      for (const part of parts) grabbed.add(part);
    }
  }
  return [...pinned].filter((part) => grabbed.has(part)).sort();
}

/**
 * Grips no touch check knows of (T-290): every grip of `cssGrips` whose element is not one of
 * `listed` (GRIP_SELECTORS and DRAGGED_WHOLE). Such a selector is a grip: a finger drags by it, so
 * it needs a finger's size, which the stories measure only for the grips they are told of. A listed
 * grip in a place of its own, or in a state (`.x .move-grip-handle:hover`), is the same grip.
 */
export function unlistedGrips(sources: string[], listed: readonly string[]): string[] {
  const known = (part: string) => {
    const subject = part.split(/[\s>+~]+/).at(-1) ?? '';
    return listed.some((grip) =>
      new RegExp(`${grip.replaceAll('.', '\\.')}(?![\\w-])`).test(subject),
    );
  };
  return cssGrips(sources).filter((part) => !known(part));
}

/** A grip styled in a script (T-294): what says so, and the classes of the element it styles. */
export interface InlineGrip {
  what: string;
  /** The classes written on the element whose `style` it is; none when it is not in a `style`. */
  classes: string[];
}

/**
 * Grips styled in a script that no touch check knows of (T-294). The grip guard reads stylesheets,
 * so a `touchAction: 'none'` or a grab cursor written in a component's `style`, in a style object
 * kept aside, or set on an element's `style` from script would make a grip it never sees. Each must
 * be on an element with a class from `listed` (GRIP_SELECTORS and DRAGGED_WHOLE): a grip styled
 * inline is still that grip, measured by its touch story. Anything else should be a class in a
 * stylesheet, where the guard sees it.
 */
export function unlistedInlineGrips(found: InlineGrip[], listed: readonly string[]): string[] {
  const names = new Set(listed.flatMap((grip) => classesIn(subjectOf(grip))));
  return found.filter((grip) => !grip.classes.some((c) => names.has(c))).map((grip) => grip.what);
}

/**
 * What is wrong with `checkedBy` (`file#Story`, the file under `root`) as the story that checks a
 * dragged-whole element's finger's size (T-290): no such file, no such story exported from it, or a
 * story that does not run on a real touch screen: one that does not ask for it, or one without the
 * `touch` tag that runs it on one (T-328). Undefined when it is that story.
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
  if (!/\btags:\s*\[[^\]]*'touch'/.test(body)) {
    return `${checkedBy} has no tags: ['touch'], so it runs with a mouse`;
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

/**
 * An attribute of a native element other than `children` (T-356): JSX in it (`onClick={() =>
 * show(<b />)}`) is drawn wherever what takes it puts it, never inside that element, so neither the
 * element nor anything around it is around that JSX.
 */
const drawnApart = (node: ts.Node): node is ts.JsxAttribute =>
  ts.isJsxAttribute(node) &&
  node.name.getText() !== 'children' &&
  /^[a-z]/.test(tagName(node.parent.parent));

/**
 * The class names written in a className, even in a conditional or a template, where a word glued
 * to a `${}` counts when the `${}` is only ever a space-led word or nothing (`timeline-bar${on ? '
 * is-on' : ''}`, T-353); what is built at runtime is not.
 */
function classesOf(node: ts.JsxOpeningLikeElement): string[] {
  const init = attribute(node, 'className')?.initializer;
  if (!init) return [];
  const classes = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) for (const w of wordsOf(n.text)) classes.add(w);
    if (ts.isTemplateExpression(n)) {
      for (const way of templateWays(n)) {
        for (const w of wordsOf(way)) if (!HOLES.test(w)) classes.add(w);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(init);
  return [...classes];
}

/** What stands in a template for the `${}` at `i` whose value the source cannot read. */
const hole = (i: number) => String.fromCharCode(0xe000 + i);
const HOLES = /[\ue000-\uf8ff]/;
/** What stands for a part no one can read inside a `${}` that is otherwise read. */
const UNKNOWN = '\uf8ff';
/** How many ways a template may read before a `${}` is taken as unknown instead. */
const MOST_WAYS = 256;

/**
 * The strings an expression may be when they are a few literals: a literal, a condition's branches,
 * a template of those. Undefined for anything else: a name, a call, `on && ' x'` (which is `false`
 * in a template), or what `known` says is counted elsewhere.
 */
function valuesOf(
  e: ts.Expression,
  known: (e: ts.Expression) => boolean = () => false,
): string[] | undefined {
  if (known(e)) return undefined;
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return valuesOf(e.expression, known);
  if (ts.isConditionalExpression(e)) {
    const [a, b] = [valuesOf(e.whenTrue, known), valuesOf(e.whenFalse, known)];
    return a && b ? [...new Set([...a, ...b])] : undefined;
  }
  // A template's `${}` no one can read stays unknown in it, apart from the template's own holes.
  if (ts.isTemplateExpression(e)) {
    return templateWays(e, known).map((way) => way.replace(new RegExp(HOLES.source, 'g'), UNKNOWN));
  }
  return undefined;
}

/**
 * Every way a template may read (T-353): each `${}` that is a few literals put in, and any other as
 * a `hole` of its own, so a word beside a `${}` reads whole when what fills it is only ever a word
 * led by a space, or nothing.
 */
function templateWays(
  e: ts.TemplateExpression,
  known: (e: ts.Expression) => boolean = () => false,
): string[] {
  let ways = [e.head.text];
  e.templateSpans.forEach((span, i) => {
    const read = valuesOf(span.expression, known);
    const values = read && read.length * ways.length <= MOST_WAYS ? read : [hole(i)];
    ways = ways.flatMap((way) => values.map((v) => way + v + span.literal.text));
  });
  return ways;
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
  /** Classes written on a control: a button, link, field or summary, or an element with a control's role. */
  controls: Set<string>;
  /** `touchAction: 'none'` and grab cursors written here, in a style or set on one. */
  inlineGrips: InlineGrip[];
  /**
   * Every element written here, with what is around it, for holding selectors against (T-298); one
   * drawn by a component that passes its className on (`ClassPasser`) as the control it draws.
   */
  elements: JsxElementFact[];
  /** The words a class built at runtime here could be made of (`looseClasses`). */
  loose: LooseClasses;
  /** Each place a component is drawn here, as a tag, with what is around it (T-353). */
  uses: ComponentUse[];
  /**
   * Capitalised names used here otherwise than as a tag, an import or a declaration (`memo(X)`,
   * `{ page: X }`, `typeof X`): a component named so may be drawn where no one can see (T-353).
   */
  references: Set<string>;
  /** Names exported here from another file (`export { X } from './x'`), or `*` for all of one. */
  reexports: Set<string>;
}

/** A component drawn in a file: its tag, the elements around it there, and its own `root`. */
export interface ComponentUse {
  tag: string;
  around: JsxNode[];
  root?: string | undefined;
  /** The component it is drawn by, as `ownerIn` reads it (T-356). */
  owner?: string | undefined;
  /**
   * The classes written on it (`className`), surely or only under a condition: a component given a
   * class may draw it on an element of its own (`<TableScroller className="glass-card">`), so it
   * counts as drawn here wherever the component puts it (T-356).
   */
  classes: string[];
  maybe: string[];
}

/** The tag names of a control a finger presses; an `<input type="hidden">` is none. */
const CONTROLS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const isControl = (node: ts.JsxOpeningLikeElement) => {
  const literal = (name: string) => {
    const init = attribute(node, name)?.initializer;
    return init && ts.isStringLiteral(init) ? init.text : '';
  };
  if (CONTROLS.has(tagName(node))) return literal('type') !== 'hidden';
  return CONTROL_ROLE.test(literal('role'));
};

/** What a className says of an element's classes: sure, only under a condition, or built. */
interface ClassReading {
  sure: string[];
  maybe: string[];
  built: boolean;
}

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * How a className expression puts classes on an element (T-298). A literal's words are sure; a
 * condition's branches are sure only where both say so; `cond && 'x'` and fallbacks only maybe. A
 * template's whole words are sure and its `${}` read the same way, but a word glued to a `${}`
 * (`timeline-bar${x}`) is built, and so is anything else: a name, a call, a property. `known` is an
 * expression whose classes are counted elsewhere (the className a component is given).
 */
function readClasses(
  expression: ts.Expression,
  known: (e: ts.Expression) => boolean = () => false,
): ClassReading {
  const none: ClassReading = { sure: [], maybe: [], built: false };
  const loosely = (r: ClassReading): ClassReading => ({
    sure: [],
    maybe: [...r.sure, ...r.maybe],
    built: r.built,
  });
  const read = (e: ts.Expression): ClassReading => {
    if (known(e)) return none;
    if (ts.isStringLiteralLike(e)) return { sure: wordsOf(e.text), maybe: [], built: false };
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return read(e.expression);
    if (ts.isConditionalExpression(e)) {
      const [a, b] = [read(e.whenTrue), read(e.whenFalse)];
      const sure = a.sure.filter((c) => b.sure.includes(c));
      return {
        sure,
        maybe: [...a.sure, ...a.maybe, ...b.sure, ...b.maybe].filter((c) => !sure.includes(c)),
        built: a.built || b.built,
      };
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return loosely(read(e.right));
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const [a, b] = [read(e.left), read(e.right)];
        return loosely({
          sure: [...a.sure, ...b.sure],
          maybe: [...a.maybe, ...b.maybe],
          built: a.built || b.built,
        });
      }
    }
    if (ts.isTemplateExpression(e)) {
      // Every way it may read: a word in each is sure, in some only maybe (T-353).
      const ways = templateWays(e, known).map(wordsOf);
      const words = [...new Set(ways.flat())];
      const plain = words.filter((w) => !HOLES.test(w));
      const sure = plain.filter((w) => ways.every((way) => way.includes(w)));
      const out: ClassReading = {
        sure,
        maybe: plain.filter((w) => !sure.includes(w)),
        built: false,
      };
      // A `${}` read as a word of its own in every way says what it says; any other part no one
      // can read (glued to a word, or inside a `${}` otherwise read) makes a class built.
      const apart = e.templateSpans.flatMap((span, i) =>
        ways.every((way) => way.includes(hole(i))) ? [[hole(i), span] as const] : [],
      );
      const marks = new Set<string>(apart.map(([mark]) => mark));
      if (words.some((w) => HOLES.test(w) && !marks.has(w))) out.built = true;
      for (const [, span] of apart) {
        const inner = read(span.expression);
        out.sure.push(...inner.sure);
        out.maybe.push(...inner.maybe);
        out.built ||= inner.built;
      }
      return out;
    }
    return { sure: [], maybe: literalsIn(e).flatMap(wordsOf), built: true };
  };
  return read(expression);
}

/** The classes of an element's className attribute, read as `readClasses` does. */
function classReadingOf(
  node: ts.JsxOpeningLikeElement,
  known?: (e: ts.Expression) => boolean,
): ClassReading {
  const init = attribute(node, 'className')?.initializer;
  if (!init) return { sure: [], maybe: [], built: false };
  if (ts.isStringLiteral(init)) return { sure: wordsOf(init.text), maybe: [], built: false };
  if (ts.isJsxExpression(init) && init.expression) return readClasses(init.expression, known);
  return { sure: [], maybe: [], built: true };
}

/**
 * An element's tag, classes and literal attributes (`htmlFor` as `for`, names in lower case).
 * `known` is what carries the className a component is given (`passerIn`): its classes are the
 * caller's, and a spread of it sets no class of its own.
 */
function nodeOf(
  node: ts.JsxOpeningLikeElement,
  known: (e: ts.Expression) => boolean = () => false,
): JsxNode {
  const attrs: Record<string, string | null> = {};
  for (const p of node.attributes.properties) {
    if (!ts.isJsxAttribute(p)) continue;
    const written = p.name.getText();
    if (/^(className|key|ref|children)$/.test(written)) continue;
    const init = p.initializer;
    const literal =
      init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
        ? init.expression.text
        : null;
    attrs[written === 'htmlFor' ? 'for' : written.toLowerCase()] = !init
      ? ''
      : ts.isStringLiteral(init)
        ? init.text
        : literal;
  }
  const reading = classReadingOf(node, known);
  const spreads = node.attributes.properties.filter(ts.isJsxSpreadAttribute);
  return {
    tag: tagName(node),
    classes: [...new Set(reading.sure)],
    maybe: [...new Set(reading.maybe)].filter((c) => !reading.sure.includes(c)),
    built: reading.built || spreads.some((s) => !known(s.expression)),
    attrs,
    open: spreads.length > 0,
  };
}

/** What stands for a component in the elements around its children: nothing a selector names. */
const componentNode = (tag: string): JsxNode => ({
  tag,
  classes: [],
  maybe: [],
  built: true,
  attrs: {},
  open: true,
});

/** What stands around JSX drawn in a place no one reads here: an ancestor no selector passes. */
const ELSEWHERE = componentNode('Elsewhere');

/**
 * A component of ours that puts the className it is given on a native control (T-298), such as a
 * link that takes a class: a class written on it is a class on that control.
 */
export interface ClassPasser {
  /** The control it draws, with the classes and attributes it writes on it itself. */
  control: JsxNode;
  /** The elements around that control inside the component, nearest first. */
  inner: JsxNode[];
  /** It spreads its props on the control, so the attributes written on it reach the control. */
  spreads: boolean;
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** The function inside a component's initializer: itself, or wrapped in forwardRef or memo. */
function functionIn(node: ts.Node): FunctionLike | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isCallExpression(node)) {
    for (const argument of node.arguments) {
      const found = functionIn(argument);
      if (found) return found;
    }
    return undefined;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return functionIn(node.expression);
  }
  return undefined;
}

/** The components a file declares at its top level, by name. */
function componentsIn(sourceFile: ts.SourceFile): [string, FunctionLike][] {
  const found: [string, FunctionLike][] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      /^[A-Z]/.test(statement.name.text)
    ) {
      found.push([statement.name.text, statement]);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !/^[A-Z]/.test(d.name.text) || !d.initializer) continue;
      const fn = functionIn(d.initializer);
      if (fn) found.push([d.name.text, fn]);
    }
  }
  return found;
}

/**
 * How a component passes its className on, if it does: read from its source (T-298). Its props
 * are followed by name: a `className` taken from them (`{ className }`, `{ className: extra }`,
 * `props.className`), or all of them spread (`{...props}`, or `{...rest}` when className was not
 * taken out of it). It passes it on when one of those is in the className of a native control, or
 * of a component in `scope` that passes it on in turn, or spread onto one.
 */
function passerIn(
  fn: FunctionLike,
  scope: (tag: string) => ClassPasser | undefined,
): ClassPasser | undefined {
  const param = fn.parameters[0];
  if (!param || !fn.body) return undefined;
  /** Names of the className; names that hold every prop, className included. */
  const named = new Set<string>();
  const whole = new Set<string>();
  const bind = (pattern: ts.BindingName) => {
    if (ts.isIdentifier(pattern)) {
      whole.add(pattern.text);
      return;
    }
    if (!ts.isObjectBindingPattern(pattern)) return;
    let takesClass = false;
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      if ((element.propertyName ?? element.name).getText() !== 'className') continue;
      takesClass = true;
      if (ts.isIdentifier(element.name)) named.add(element.name.text);
    }
    const rest = pattern.elements.find((element) => element.dotDotDotToken);
    if (rest && ts.isIdentifier(rest.name) && !takesClass) whole.add(rest.name.text);
  };
  bind(param.name);
  // `const { className, ...rest } = props;` in its body.
  const unpack = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      whole.has(node.initializer.text)
    ) {
      bind(node.name);
    }
    ts.forEachChild(node, unpack);
  };
  unpack(fn.body);
  const carries = (node: ts.Node): boolean => {
    if (
      ts.isIdentifier(node) &&
      named.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'className' &&
      ts.isIdentifier(node.expression) &&
      whole.has(node.expression.text)
    ) {
      return true;
    }
    return ts.forEachChild(node, carries) ?? false;
  };
  /** The className it is given itself, or every prop spread: the caller's classes, not built. */
  const given = (e: ts.Expression) =>
    (ts.isIdentifier(e) && (named.has(e.text) || whole.has(e.text))) ||
    (ts.isPropertyAccessExpression(e) &&
      e.name.text === 'className' &&
      ts.isIdentifier(e.expression) &&
      whole.has(e.expression.text));
  let found: ClassPasser | undefined;
  const visit = (node: ts.Node, path: JsxNode[]) => {
    if (found) return;
    // A control drawn by a native element's attribute lands where no one reads here (T-356).
    if (drawnApart(node)) {
      ts.forEachChild(node, (child) => visit(child, [ELSEWHERE]));
      return;
    }
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) {
      ts.forEachChild(node, (child) => visit(child, path));
      return;
    }
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const tag = tagName(opening);
    const own = nodeOf(opening, given);
    const native = /^[a-z]/.test(tag);
    const spreads = opening.attributes.properties.some(
      (p) =>
        ts.isJsxSpreadAttribute(p) && ts.isIdentifier(p.expression) && whole.has(p.expression.text),
    );
    const init = attribute(opening, 'className')?.initializer;
    const passes = spreads || (init !== undefined && carries(init));
    const through = native ? undefined : scope(tag);
    if (passes && through) {
      found = {
        control: {
          ...through.control,
          classes: [...through.control.classes, ...own.classes],
          maybe: [...through.control.maybe, ...own.maybe],
          built: through.control.built || own.built,
        },
        inner: [...through.inner, ...path],
        spreads: spreads && through.spreads,
      };
    } else if (passes && native && isControl(opening)) {
      found = { control: own, inner: path, spreads };
    }
    const here = native ? own : componentNode(tag);
    ts.forEachChild(node, (child) => visit(child, [here, ...path]));
  };
  visit(fn.body, []);
  return found;
}

/** The components of a file that pass their className on to a control, with `scope` for imports. */
export function classPassers(
  file: string,
  source: string,
  scope: (tag: string) => ClassPasser | undefined = () => undefined,
): Map<string, ClassPasser> {
  const found = new Map<string, ClassPasser>();
  const inFile = (tag: string) => found.get(tag) ?? scope(tag);
  const components = componentsIn(parse(file, source));
  // Until nothing more is found: one may pass through another declared below it.
  for (let size = -1; size !== found.size; ) {
    size = found.size;
    for (const [name, fn] of components) {
      if (found.has(name)) continue;
      const passer = passerIn(fn, inFile);
      if (passer) found.set(name, passer);
    }
  }
  return found;
}

/** The string literals in an expression, conditional branches and fallbacks included. */
function literalsIn(node: ts.Node): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  const found: string[] = [];
  ts.forEachChild(node, (child) => {
    found.push(...literalsIn(child));
  });
  return found;
}

/** Whether a style property and its possible values make a grip: no panning, or a grab cursor. */
function gripStyle(property: string, values: string[]): boolean {
  if (/^(touchAction|touch-action)$/.test(property)) {
    return values.some((v) => PINNED.test(v.trim().toLowerCase()));
  }
  return property === 'cursor' && values.some(isGrabCursor);
}

/**
 * A grip styled in a script at `node`, if it is one: `touchAction: 'none'` or a grab cursor in an
 * object literal (a JSX `style`, or a style object kept aside), assigned to an element's `style`,
 * or set with `style.setProperty`.
 */
function inlineGripAt(node: ts.Node): InlineGrip | undefined {
  if (ts.isPropertyAssignment(node)) {
    const property = node.name.getText().replace(/^['"]|['"]$/g, '');
    if (!gripStyle(property, literalsIn(node.initializer))) return undefined;
    // In `style={{ ... }}`: the object, its braces, the attribute, the attributes, the element.
    const attr = node.parent.parent?.parent;
    const element = attr?.parent?.parent;
    const inStyle =
      attr &&
      ts.isJsxAttribute(attr) &&
      attr.name.getText() === 'style' &&
      element &&
      (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element));
    return {
      what: inStyle ? `<${tagName(element)}> ${node.getText()}` : node.getText(),
      classes: inStyle ? classesOf(element) : [],
    };
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    /\.style$|^style$/.test(node.left.expression.getText()) &&
    gripStyle(node.left.name.text, literalsIn(node.right))
  ) {
    return { what: node.getText(), classes: [] };
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'setProperty' &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[1] &&
    gripStyle(node.arguments[0].text, literalsIn(node.arguments[1]))
  ) {
    return { what: node.getText(), classes: [] };
  }
  return undefined;
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

/**
 * The words of a script a class built at runtime could be made of (`LooseClasses`, T-298): every
 * string's words but those of a native element's own className, which the guard reads where they
 * are written, and every piece of a template glued to a `${}`, wherever it is.
 */
export function looseClasses(file: string, source: string): LooseClasses {
  const loose: LooseClasses = { whole: new Set(), prefixes: new Set(), suffixes: new Set() };
  const visit = (node: ts.Node, ownClass: boolean): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === 'className' &&
      /^[a-z]/.test(tagName(node.parent.parent as ts.JsxOpeningLikeElement))
    ) {
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (ts.isStringLiteralLike(node) && !ownClass) {
      for (const w of wordsOf(node.text)) loose.whole.add(w);
    }
    if (ts.isTemplateExpression(node)) {
      // Read in every way it may read (T-353): a word glued to a `${}` no one can read is the start
      // or the end of a class, or a piece of one; any other word is whole.
      for (const way of templateWays(node)) {
        for (const w of wordsOf(way)) {
          const pieces = w.split(new RegExp(HOLES.source, 'g'));
          if (pieces.length === 1) {
            if (!ownClass) loose.whole.add(w);
            continue;
          }
          pieces.forEach((piece, at) => {
            if (!piece) return;
            if (at < pieces.length - 1) loose.prefixes.add(piece);
            if (at > 0) loose.suffixes.add(piece);
          });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, ownClass));
  };
  visit(parse(file, source), false);
  return loose;
}

/**
 * What the design guard reads in a script. `passers` names the components in its scope that pass a
 * className on to a control (`ClassPasser`, T-298): a class written on one is a control's.
 */
export function jsxFacts(
  file: string,
  source: string,
  styled: StyledBy,
  passers: (tag: string) => ClassPasser | undefined = () => undefined,
): JsxFacts {
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
    controls: new Set(),
    inlineGrips: [],
    elements: [],
    loose: looseClasses(file, source),
    uses: [],
    references: new Set(),
    reexports: new Set(),
  };
  const sourceFile = parse(file, source);
  const components = new Map<ts.Node, string>(
    componentsIn(sourceFile).map(([component, fn]) => [fn, component]),
  );
  const visit = (
    node: ts.Node,
    ancestors: string[],
    inNote: boolean,
    parent: string[] | null,
    path: JsxNode[],
  ): void => {
    let classes = ancestors;
    let note = inNote;
    let around = parent;
    let within = path;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagName(node);
      const own = classesOf(node);
      const unstyled = !attribute(node, 'className') && !hasSpread(node);
      for (const c of own) facts.allClasses.add(c);
      const passer = /^[A-Z]/.test(tag) ? passers(tag) : undefined;
      if (isControl(node) || passer) for (const c of own) facts.controls.add(c);
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
      const written = nodeOf(opening);
      const native = /^[a-z]/.test(tag);
      const passer = native ? undefined : passers(tag);
      const root = rootIn(node, components);
      const owner = ownerIn(node, components);
      if (native) facts.elements.push({ ...written, around: path, root, owner });
      else {
        facts.uses.push({
          tag,
          around: path,
          root,
          owner,
          classes: written.classes,
          maybe: written.maybe,
        });
      }
      if (passer) {
        facts.elements.push({
          ...passer.control,
          classes: [...passer.control.classes, ...written.classes],
          maybe: [...passer.control.maybe, ...written.maybe],
          built: passer.control.built || written.built,
          attrs: passer.spreads
            ? { ...passer.control.attrs, ...written.attrs }
            : passer.control.attrs,
          around: [...passer.inner, ...path],
          root,
          owner,
        });
      }
      within = [native ? written : componentNode(tag), ...path];
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
    const grip = inlineGripAt(node);
    if (grip) facts.inlineGrips.push(grip);
    if (ts.isStringLiteralLike(node)) {
      if (STRING_COLOUR.test(node.text)) facts.rawColours.push(node.text);
      if (OPAQUE_SURFACE.test(node.text)) facts.opaqueSurfaces.push(node.text);
    }
    if (ts.isIdentifier(node) && /^[A-Z]/.test(node.text) && isReference(node)) {
      facts.references.add(node.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const e of clause.elements) facts.reexports.add((e.propertyName ?? e.name).text);
      } else {
        facts.reexports.add('*');
      }
    }
    // What a portal draws lands elsewhere (`document.body`): none of the elements around the call
    // are around it (T-353); nor around JSX in a native element's attribute (T-356).
    if (isPortal(node) || drawnApart(node)) {
      ts.forEachChild(node, (child) => visit(child, [], false, null, []));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, classes, note, around, within));
  };
  visit(sourceFile, [], false, null, []);
  return facts;
}

/** A call that draws its JSX somewhere else: `createPortal(...)`, `ReactDOM.createPortal(...)`. */
function isPortal(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === 'createPortal') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createPortal')
  );
}

/**
 * Whether a name is used as a value or a type, not as a tag, an import or export of it, the name of
 * what it declares, or a property's name (T-353).
 */
function isReference(node: ts.Identifier): boolean {
  const p = node.parent;
  if (
    (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
    p.tagName === node
  ) {
    return false;
  }
  if (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isJsxAttribute(p)
  ) {
    return false;
  }
  const named =
    ts.isFunctionDeclaration(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isClassDeclaration(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isTypeParameterDeclaration(p) ||
    ts.isBindingElement(p) ||
    ts.isPropertyAssignment(p) ||
    ts.isPropertySignature(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isEnumMember(p);
  if (named && (p as { name?: ts.Node }).name === node) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isQualifiedName(p) && p.right === node) return false;
  return true;
}

/**
 * The component of a file that draws `node` (T-356): the one whose function it is written in,
 * whatever stands between (a variable, a callback, a native element's attribute), so its `root`
 * when it has one; `*` for JSX outside every component (a helper any of them may call); undefined
 * for what a portal draws, which lands outside whatever the component is drawn in.
 */
function ownerIn(node: ts.Node, components: Map<ts.Node, string>): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (isPortal(p)) return undefined;
    const component = components.get(p);
    if (component) return component;
  }
  return '*';
}

/**
 * The component of a file whose returned JSX holds `node` with nothing between (T-353): the JSX
 * outermost around it is returned by that component (or is its arrow's body), through brackets, a
 * condition's branch or `&&`. JSX kept in a variable, made by another function, put elsewhere by a
 * portal (`createPortal`, wherever the call stands in the returned JSX) or held in a native
 * element's attribute (`onClick={() => show(<b />)}`, T-356) has none: where it lands, no one reads
 * here.
 */
function rootIn(node: ts.Node, components: Map<ts.Node, string>): string | undefined {
  let top = node;
  for (let p = node.parent; p; p = p.parent) {
    if (isPortal(p) || drawnApart(p)) return undefined;
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) top = p;
  }
  for (let at: ts.Node = top; ; ) {
    const p = at.parent;
    if (!p) return undefined;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) {
      at = p;
    } else if (ts.isConditionalExpression(p) && p.condition !== at) {
      at = p;
    } else if (
      ts.isBinaryExpression(p) &&
      p.right === at &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(p.operatorToken.kind)
    ) {
      at = p;
    } else if (ts.isArrowFunction(p)) {
      return p.body === at ? components.get(p) : undefined;
    } else if (ts.isReturnStatement(p)) {
      let fn: ts.Node | undefined = p.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      return fn ? components.get(fn) : undefined;
    } else {
      return undefined;
    }
  }
}

/**
 * The app's elements with every place they are drawn (T-353): an element that is its component's
 * (`root`) is drawn wherever that component is, so the elements around each tag that draws it, in
 * the file that does, are around it too, and so on outwards while that tag is its own component's
 * too. A component drawn nowhere the source shows, used otherwise than as a tag (a name passed on,
 * `memo(X)`), exported again from another file, or drawn in more places than `MOST_PLACES` is in no
 * place known, and only what is around it in its file counts.
 */
export function elementsInPlace(
  sources: readonly (readonly [string, string])[],
  factsOf: (file: string) => JsxFacts,
): JsxElementFact[] {
  const resolve = componentResolver(sources);
  const sites = new Map<string, { file: string; use: ComponentUse }[]>();
  const unknown = new Set<string>();
  const reexported = new Set<string>();
  for (const [file] of sources) {
    const facts = factsOf(file);
    for (const use of facts.uses) {
      const id = resolve(file, use.tag);
      if (id) sites.set(id, [...(sites.get(id) ?? []), { file, use }]);
    }
    for (const ref of facts.references) {
      const id = resolve(file, ref);
      if (id) unknown.add(id);
    }
    for (const name of facts.reexports) reexported.add(name);
  }
  const memo = new Map<string, JsxNode[][]>();
  /** The elements around each place a component is drawn; `[[]]` when its places are unknown. */
  const outward = (id: string, seen: ReadonlySet<string>): JsxNode[][] => {
    const done = memo.get(id);
    if (done) return done;
    const component = id.slice(id.lastIndexOf('#') + 1);
    const here = sites.get(id);
    if (
      !here ||
      unknown.has(id) ||
      seen.has(id) ||
      reexported.has('*') ||
      reexported.has(component)
    ) {
      return [[]];
    }
    const deeper = new Set([...seen, id]);
    const places = here.flatMap(({ file, use }) =>
      (use.root ? outward(`${file}#${use.root}`, deeper) : [[]]).map((rest) => [
        ...use.around,
        ...rest,
      ]),
    );
    const result = places.length > MOST_PLACES ? [[]] : places;
    memo.set(id, result);
    return result;
  };
  return sources.flatMap(([file]) =>
    factsOf(file).elements.map((element) =>
      element.root
        ? { ...element, outside: outward(`${file}#${element.root}`, new Set()) }
        : element,
    ),
  );
}

/** How many places a component may be drawn in before they count as unknown. */
const MOST_PLACES = 64;

/**
 * The component a tag stands for in a file, as `file#Name`: one the file declares, or one it
 * imports from another of `sources` (or of the disk), under another name too; else undefined.
 */
function componentResolver(
  sources: readonly (readonly [string, string])[],
): (file: string, tag: string) => string | undefined {
  const known = new Set(sources.map(([file]) => file));
  const exists = (path: string) => known.has(path) || existsSync(path);
  const declared = new Map<string, Set<string>>();
  const imports = new Map<string, Map<string, { file: string; name: string }>>();
  for (const [file, source] of sources) {
    declared.set(file, new Set(componentsIn(parse(file, source)).map(([component]) => component)));
    imports.set(file, importNames(file, source, exists));
  }
  return (file, tag) => {
    if (declared.get(file)?.has(tag)) return `${file}#${tag}`;
    const from = imports.get(file)?.get(tag);
    return from ? `${from.file}#${from.name}` : undefined;
  };
}

/**
 * Components drawn inside a glass card that draw one themselves (ADR-114), read per component
 * (T-356): a file that draws a glass card in one component does not make its others draw one. A
 * component draws one when an element it draws (`owner`) has the class, surely or only under a
 * condition, when it writes the class on a component it draws (`<Wrapper className="glass-card">`),
 * or when it draws a component that does, in its own file or another. JSX outside every
 * component (a helper) may be any of them's; what a portal draws lands outside the card.
 */
export function glassInGlass(
  sources: readonly (readonly [string, string])[],
  factsOf: (file: string) => JsxFacts,
): { file: string; tag: string }[] {
  const resolve = componentResolver(sources);
  const memo = new Map<string, boolean>();
  const draws = (id: string, seen: ReadonlySet<string>): boolean => {
    const done = memo.get(id);
    if (done !== undefined) return done;
    if (seen.has(id)) return false;
    const at = id.lastIndexOf('#');
    const [file, component] = [id.slice(0, at), id.slice(at + 1)];
    const facts = factsOf(file);
    if (!facts) return false;
    const its = (owner: string | undefined) => owner === component || owner === '*';
    const deeper = new Set([...seen, id]);
    const found =
      facts.elements.some(
        (e) => its(e.owner) && [...e.classes, ...e.maybe].includes('glass-card'),
      ) ||
      facts.uses.some((use) => {
        if (!its(use.owner)) return false;
        // A class written on a component of ours is one it draws, whatever element it lands on.
        if ([...use.classes, ...use.maybe].includes('glass-card')) return true;
        const target = resolve(file, use.tag);
        return target !== undefined && draws(target, deeper);
      });
    // A no reached while some components were left out on the way may be a yes from elsewhere.
    if (found || seen.size === 0) memo.set(id, found);
    return found;
  };
  return sources.flatMap(([file]) =>
    [...factsOf(file).renderedInGlass].flatMap((tag) => {
      const target = resolve(file, tag);
      return target !== undefined && draws(target, new Set()) ? [{ file, tag }] : [];
    }),
  );
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

/** Each name a file imports from another of our files: that file, and the name it exports. */
function importNames(
  file: string,
  source: string,
  exists: (path: string) => boolean,
): Map<string, { file: string; name: string }> {
  const found = new Map<string, { file: string; name: string }>();
  for (const [local, target] of importsOf(file, source, exists)) {
    found.set(local, { file: target, name: local });
  }
  parse(file, source).forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const at = found.get(element.name.text);
      if (at && element.propertyName) at.name = element.propertyName.text;
    }
  });
  return found;
}

/**
 * The components that pass a className on to a control, as each file sees them: its own, and those
 * it imports, found again until no more turn up, since one may pass through another (T-298).
 */
export function passersInScope(
  sources: readonly (readonly [string, string])[],
): (file: string) => (tag: string) => ClassPasser | undefined {
  const byFile = new Map<string, Map<string, ClassPasser>>();
  // A file of `sources` counts as there, so the guard's own tests can hold sources of their own.
  const known = new Set(sources.map(([file]) => file));
  const exists = (path: string) => known.has(path) || existsSync(path);
  const imports = new Map(
    sources.map(([file, source]) => [file, importNames(file, source, exists)]),
  );
  const scope = (file: string) => (tag: string) => {
    const own = byFile.get(file)?.get(tag);
    if (own) return own;
    const from = imports.get(file)?.get(tag);
    return from ? byFile.get(from.file)?.get(from.name) : undefined;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const [file, source] of sources) {
      const found = classPassers(file, source, scope(file));
      if (found.size > (byFile.get(file)?.size ?? 0)) {
        byFile.set(file, found);
        grew = true;
      }
    }
  }
  return scope;
}

/** Where each component a file imports from another of our files comes from. */
function importsOf(
  file: string,
  source: string,
  exists: (path: string) => boolean = existsSync,
): Map<string, string> {
  const found = new Map<string, string>();
  parse(file, source).forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const from = node.moduleSpecifier.text;
    if (!from.startsWith('.')) return;
    const path = join(file, '..', from).replaceAll('\\', '/');
    const target = [`${path}.tsx`, `${path}.ts`].find((f) => exists(f));
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
const scriptSources = scripts.map((file) => [file, readFileSync(file, 'utf8')] as const);
const passers = passersInScope(scriptSources);
const facts = new Map(
  scriptSources.map(([file, source]) => [file, jsxFacts(file, source, styled, passers(file))]),
);
const factsOf = (file: string) => facts.get(file) as JsxFacts;
/** The stylesheets main.tsx imports, in its order: the order of the cascade. */
const LOAD_ORDER = [
  ...readFileSync(join(SRC, 'main.tsx'), 'utf8').matchAll(/import '\.\/(styles\/[\w-]+\.css)'/g),
].map((m) => m[1]);
const rank = (file: string) => {
  const at = LOAD_ORDER.indexOf(name(file));
  return at < 0 ? LOAD_ORDER.length : at;
};
/** The stylesheets as the browser reads them; one main.tsx does not import (the Builder's) last. */
const inLoadOrder = [...cssSources].sort(([a], [b]) => rank(a) - rank(b));
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
/** Every grip the touch checks know of: GRIP_SELECTORS and what is dragged whole. */
const LISTED_GRIPS = [...GRIP_SELECTORS, ...Object.keys(DRAGGED_WHOLE)];
/** The stylesheet that gives a selector its height, for a list kept per file. */
const sheetSizing = (selector: string) =>
  name(
    cssSources.find(([, source]) =>
      cssDeclarations(source).some(
        (d) => HEIGHT.test(d.property) && selectorsOf(d.selector).includes(selector),
      ),
    )?.[0] ?? SRC,
  );
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

  it("[NFR-005] finds a target of a fixed height under a finger's, however it is written (T-294)", () => {
    // What a finger presses: controls by tag or role, classes written on them, grips.
    const target = (part: string) =>
      isTargetSelector(part, new Set(['chip']), new Set(['timeline-bar']));
    for (const part of [
      'button',
      '.zoom button:hover',
      '.list > a',
      '.form input[type="checkbox"]',
      ':where(input:is([type="checkbox"], [type="radio"]))',
      'summary',
      '.menu [role="menuitem"]',
      '.chip',
      '.row .chip.is-on',
      '.timeline-bar',
      '.chip:not(.x)',
    ]) {
      expect(target(part), part).toBe(true);
    }
    for (const part of [
      '.chip::before',
      '.timeline-bar::after',
      '.chip-count',
      '.card:has(button)',
      '.card:not(.chip)',
      '[data-kind="button"]',
      '.panel a .icon',
      '.area',
    ]) {
      expect(target(part), part).toBe(false);
    }
    expect(subjectOf('.a :is(b c) > .d:not(.e f)')).toBe('.d:not(.e f)');

    const short = (css: string) => shortOnTouch([css], target);
    // The timeline bar of T-293: 24 px, with nothing for a finger on a touch screen.
    expect(short('.timeline-bar { height: 24px; }')).toEqual(['.timeline-bar']);
    // In rem, em or a token the sheets set; a min-height or block-size alike; the selector's
    // other parts that are no target are no business of this check.
    expect(
      short(`
        :root { --space-6: 24px; }
        .chip { height: 1.5rem; } button { min-block-size: var(--space-6); }
        .area, .panel button { min-height: 2em; }
      `),
    ).toEqual(['.chip', '.panel button', 'button']);
    // A finger's height on a touch screen, or a press area of one drawn over it, keeps its look.
    expect(
      short(`
        .chip, .timeline-bar { height: 24px; }
        @media (pointer: coarse) {
          .chip { min-height: var(--hit-target-touch); }
          .timeline-bar::after { content: ""; height: var(--hit-target-touch); }
        }
      `),
    ).toEqual([]);
    // A touch rule that asks for less is the same mistake; a press area under a phone's width
    // only is none for a tablet.
    expect(short('@media (pointer: coarse) { button { height: 28px; } }')).toEqual(['button']);
    expect(
      short(`
        .timeline-bar { height: 24px; }
        @media (max-width: 767px) { @media (pointer: coarse) { .timeline-bar::after { height: 44px; } } }
      `),
    ).toEqual(['.timeline-bar']);
    // What grows with its contents or its place, a finger's height or more, a control hidden by a
    // 1 px box, and what no finger presses pass.
    expect(
      short(`
        button { height: 100%; min-height: calc(var(--space-5) + 1rem); }
        .chip { height: 48px; }
        .visually-hidden, input.file { height: 1px; }
        .chip::before, .area { height: 8px; }
      `),
    ).toEqual([]);
  });

  it('[NFR-007] reads JSX for controls and for grips styled outside a stylesheet (T-294)', () => {
    const see = (source: string) => jsxFacts('x.tsx', source, none);
    expect([
      ...see(`<>
        <button className="a" /><a className="b" /><input className="c" type="checkbox" />
        <div role="button" className="d" /><span role="img" className="e" />
        <input type="hidden" className="f" /><div className="g" />
      </>`).controls,
    ]).toEqual(['a', 'b', 'c', 'd']);
    const grips = (source: string) =>
      unlistedInlineGrips(see(source).inlineGrips, ['.move-grip-handle', '.timeline-bar']);
    // In a style, in a style object kept aside, set from script, conditional or not.
    expect(grips(`<span className="handle" style={{ touchAction: 'none' }} />`)).toEqual([
      "<span> touchAction: 'none'",
    ]);
    expect(grips(`<div style={{ cursor: dragging ? 'grabbing' : 'grab' }} />`)).toEqual([
      "<div> cursor: dragging ? 'grabbing' : 'grab'",
    ]);
    expect(grips(`const grip = { 'touch-action': 'none' };`)).toEqual(["'touch-action': 'none'"]);
    expect(grips(`el.style.touchAction = 'none';`)).toEqual(["el.style.touchAction = 'none'"]);
    expect(grips(`el.style.setProperty('cursor', 'url(h.svg), move');`)).toEqual([
      "el.style.setProperty('cursor', 'url(h.svg), move')",
    ]);
    // A listed grip or dragged-whole element styled inline is the grip its touch story measures.
    expect(
      grips(`<>
        <span className="move-grip-handle" style={{ touchAction: 'none', cursor: 'grab' }} />
        <button className={live ? 'timeline-bar is-dragging' : 'timeline-bar'} style={{ cursor: 'grabbing' }} />
      </>`),
    ).toEqual([]);
    // A pointer and a pan are no grip; a cursor that is data is none either.
    expect(
      grips(`<>
        <div style={{ cursor: 'pointer', touchAction: 'pan-y' }} />
        <List query={{ cursor: next, limit: 50 }} />
      </>`),
    ).toEqual([]);
  });

  it('[NFR-005] sees a class put on a control through a component of ours (T-298)', () => {
    const library = `
      export function Link({ to, className, children }: P) {
        return <a href={to} className={className ? \`go \${className}\` : 'go'}>{children}</a>;
      }
      export const Plain = ({ className }: P) => <div className={className} />;
      export const Field = forwardRef<HTMLInputElement, P>((props, ref) => (
        <span className="wrap"><input ref={ref} className={props.className} /></span>
      ));
      export function Rest({ label, ...rest }: P) {
        return <button type="button" {...rest}>{label}</button>;
      }
      export function Taken({ className, ...rest }: P) {
        return <div className={className}><button type="button" {...rest} /></div>;
      }
      export function Unpacked(props: P) {
        const { className: extra, ...others } = props;
        return <select className={extra} {...others} />;
      }
      export function Nav({ className }: P) {
        return <nav><Item className={className} /></nav>;
      }
      const Item = ({ className }: P) => <Link to="/" className={className} />;
    `;
    // Read from their source: a className or every prop on a control, or through another such.
    const found = classPassers('a/link.tsx', library);
    expect([...found.keys()]).toEqual(['Link', 'Field', 'Rest', 'Unpacked', 'Item', 'Nav']);
    expect(found.get('Nav')).toEqual({
      control: {
        tag: 'a',
        classes: ['go'],
        maybe: [],
        built: false,
        attrs: { href: null },
        open: false,
      },
      inner: [{ tag: 'nav', classes: [], maybe: [], built: false, attrs: {}, open: false }],
      spreads: false,
    });
    expect(found.get('Field')?.inner.map((n) => n.classes)).toEqual([['wrap']]);

    // Imported, under another name too: a class written on one is a control's, where it sits.
    const page = `
      import { Link as Go, Plain, Rest } from './link';
      export const Page = () => (
        <div className="tools">
          <Go to="/" className="chip" /><Plain className="card" /><Rest className="act" />
        </div>
      );
    `;
    const scope = passersInScope([
      ['a/link.tsx', library],
      ['a/page.tsx', page],
    ])('a/page.tsx');
    const facts = jsxFacts('a/page.tsx', page, none, scope);
    expect([...facts.controls].sort()).toEqual(['act', 'chip']);
    expect([...jsxFacts('a/page.tsx', page, none).controls]).toEqual([]);
    const chip = facts.elements.find((e) => e.classes.includes('chip'));
    expect(chip?.tag).toBe('a');
    expect(chip?.classes).toEqual(['go', 'chip']);
    expect(chip?.around.map((n) => n.classes)).toEqual([['tools']]);
    // So a short height on it is a short target's, which it was not without them.
    const short = (controls: Set<string>) =>
      shortOnTouch(['.chip, .card { height: 24px; }'], (part) =>
        isTargetSelector(part, controls, new Set()),
      );
    expect(short(facts.controls)).toEqual(['.chip']);
    expect(short(jsxFacts('a/page.tsx', page, none).controls)).toEqual([]);
  });

  it("[NFR-005] credits a finger's height under another selector by the elements it reaches (T-298)", () => {
    const see = (code: string) => jsxFacts('x.tsx', code, none).elements;
    const page = see(`<>
      <div className="zoom"><button className="zoom-btn" /></div>
      <div className="zoom"><span><button className="zoom-btn" type="button" /></span></div>
    </>`);
    const short = (css: string, elements = page, carry?: MayCarry) =>
      shortOnTouch(
        [css],
        (part) => isTargetSelector(part, new Set(['zoom-btn']), new Set()),
        elements,
        carry,
      );
    const base = '.zoom-btn { height: 24px; }';
    const touch = (rule: string) => `${base} @media (pointer: coarse) { ${rule} }`;
    // A touch rule that reaches every element the short one sizes: a min-height, or a press area.
    expect(short(touch('.zoom button { min-height: var(--hit-target-touch); }'))).toEqual([]);
    expect(short(touch('.zoom button::after { content: ""; height: 44px; }'))).toEqual([]);
    expect(
      short(touch(':is(.zoom, .bar) [type="button"], .zoom > button { min-height: 44px; }')),
    ).toEqual([]);
    // One that reaches only some of them, in a state, past a sibling, or on some screens is none.
    expect(short(touch('.zoom > button { min-height: 44px; }'))).toEqual(['.zoom-btn']);
    expect(short(touch('.zoom button:hover { min-height: 44px; }'))).toEqual(['.zoom-btn']);
    expect(short(touch('.zoom + .zoom button { min-height: 44px; }'))).toEqual(['.zoom-btn']);
    expect(short(touch('.zoom button:not([type="button"]) { min-height: 44px; }'))).toEqual([
      '.zoom-btn',
    ]);
    expect(
      short(
        `${base} @media (pointer: coarse) and (max-width: 767px) { .zoom button { min-height: 44px; } }`,
      ),
    ).toEqual(['.zoom-btn']);
    // A height wins over a min-height, and over a height only from a more specific selector.
    expect(
      short(
        '.zoom-btn { min-height: 24px; } @media (pointer: coarse) { button { height: 44px; } }',
      ),
    ).toEqual([]);
    expect(short(touch('.zoom button.zoom-btn { height: 44px; }'))).toEqual([]);
    expect(short(touch('.zoom button { height: 44px; }'))).toEqual([]);
    expect(short(touch('button { height: 44px; }'))).toEqual(['.zoom-btn']);
    // An element it may size outside the rule's reach, or none in the source: its own selector only.
    const outside = [...page, ...see('<button className="zoom-btn" />')];
    expect(short(touch('.zoom button { min-height: 44px; }'), outside)).toEqual(['.zoom-btn']);
    expect(short(touch('.zoom button { min-height: 44px; }'), [])).toEqual(['.zoom-btn']);
    expect(short(touch('.zoom-btn { min-height: 44px; }'), [])).toEqual([]);

    expect(specificity('.a :is(#b, c) > d:where(.e)::after')).toEqual([1, 1, 2]);
    const [first, second] = page.filter((e) => e.tag === 'button') as JsxElementFact[];
    expect(second?.around.map((n) => n.tag)).toEqual(['span', 'div']);
    expect(surelyReaches('.zoom > .zoom-btn', first as JsxElementFact)).toBe(true);
    expect(surelyReaches('.zoom > .zoom-btn', second as JsxElementFact)).toBe(false);
    expect(mayReach('.elsewhere .zoom-btn:focus-visible', second as JsxElementFact)).toBe(true);
    expect(mayReach('.zoom-btn[type="submit"]', second as JsxElementFact)).toBe(false);
  });

  it("[NFR-005] credits no finger's height under another selector to an element it cannot see whole (T-298)", () => {
    const read = (code: string) => {
      const facts = jsxFacts('x.tsx', code, none);
      return { elements: facts.elements, carry: mayCarryFrom([facts.loose]) };
    };
    const covered =
      '.zoom-btn { height: 24px; } @media (pointer: coarse) { .zoom button { min-height: 44px; } }';
    const short = (code: string) => {
      const { elements, carry } = read(code);
      return shortOnTouch(
        [covered],
        (part) => isTargetSelector(part, new Set(['zoom-btn']), new Set()),
        elements,
        carry,
      );
    };
    const inZoom = '<div className="zoom"><button className="zoom-btn" /></div>';
    expect(short(`<>${inZoom}</>`)).toEqual([]);
    // A class written in a template, beside a condition's: the element is seen, outside the cover.
    expect(short(`<>${inZoom}<button className={\`zoom-btn \${on ? 'on' : ''}\`} /></>`)).toEqual([
      '.zoom-btn',
    ]);
    // A class built at runtime from words the scripts hold, whole or glued to a `${}`.
    expect(short(`<>${inZoom}<button className={cls} /></>; const cls = 'zoom-btn';`)).toEqual([
      '.zoom-btn',
    ]);
    expect(short(`<>${inZoom}<button className={\`zoom-\${size}\`} /></>`)).toEqual(['.zoom-btn']);
    expect(short(`<>${inZoom}<button {...props} /></>; use('zoom-btn');`)).toEqual(['.zoom-btn']);
    // A class given to a component that is not seen to pass it on may end up on anything built.
    expect(short(`<>${inZoom}<Chip className="zoom-btn" /><a className={own} /></>`)).toEqual([
      '.zoom-btn',
    ]);
    // Built from words that cannot make the class: no element of it is hidden from the guard.
    expect(short(`<>${inZoom}<button className={\`tag-\${size}\`} /></>`)).toEqual([]);
    // Past a component, an element is in no known place: it may draw it anywhere (a portal).
    expect(
      short(
        `<>${inZoom}<div className="zoom"><OverlayLayer><button className="zoom-btn" /></OverlayLayer></div></>`,
      ),
    ).toEqual(['.zoom-btn']);
    const { elements } = read(
      '<div className="zoom"><span><Tip><button className="zoom-btn" /></Tip></span></div>',
    );
    const [tipped] = elements.filter((e) => e.tag === 'button');
    expect(tipped?.around.map((n) => n.tag)).toEqual(['Tip', 'span', 'div']);
    expect(surelyReaches('.zoom button', tipped as JsxElementFact)).toBe(false);
    expect(surelyReaches('button', tipped as JsxElementFact)).toBe(true);

    // What a className says: sure, only under a condition, or built at runtime.
    const [one] = read(
      `<button className={\`a \${on ? 'b c' : 'b'} \${off && 'd'} e\${x} f\`} />`,
    ).elements;
    expect([one?.classes, one?.maybe, one?.built]).toEqual([['a', 'b', 'f'], ['c', 'd'], true]);
    const [two] = read("<a className={on ? 'x y' : 'y'} />").elements;
    expect([two?.classes, two?.maybe, two?.built]).toEqual([['y'], ['x'], false]);
  });

  it('[NFR-005] reads a class beside a placeholder that is only ever a word led by a space, or nothing (T-353)', () => {
    const see = (code: string) => jsxFacts('x.tsx', code, none);
    // The row of the backlog: the class before the placeholder is whole, what it adds is maybe.
    const row = `\`sprint-ticket\${held ? ' is-dragging' : ''}\${over ? ' is-drop-before' : ''}\``;
    expect([...see(`<li role="button" className={${row}} />`).controls].sort()).toEqual([
      'is-dragging',
      'is-drop-before',
      'sprint-ticket',
    ]);
    const reading = (className: string) => {
      const [element] = see(`<button className={${className}} />`).elements;
      return [element?.classes, element?.maybe, element?.built];
    };
    expect(reading(row)).toEqual([['sprint-ticket'], ['is-dragging', 'is-drop-before'], false]);
    // After a placeholder too, and in a template inside one; a word the placeholder may lengthen
    // is no class of its own, and one glued to what no one can read (`&&`, which may be `false`)
    // is built.
    expect(reading(`\`\${on ? 'is-on ' : ''}chip\``)).toEqual([['chip'], ['is-on'], false]);
    expect(reading(`\`chip\${on ? \` is-\${tone}\` : ''}\``)).toEqual([['chip'], [], true]);
    expect(reading(`\`chip\${wide ? '-wide' : ''}\``)).toEqual([[], ['chip-wide', 'chip'], false]);
    expect(reading(`\`chip\${on && ' is-on'}\``)).toEqual([[], [], true]);
    expect([...see(`<button className={\`zoom-\${size}\`} />`).controls]).toEqual([]);
    // So a short height on such a control is a short target's, and a check box drawn its own way
    // under such a class is found.
    expect(
      shortOnTouch(['.sprint-ticket { height: 24px; }'], (part) =>
        isTargetSelector(part, see(`<li role="button" className={${row}} />`).controls, new Set()),
      ),
    ).toEqual(['.sprint-ticket']);
    const box: [string, string] = [
      'a.tsx',
      `export const A = () => <input type="checkbox" className={\`mine\${on ? ' on' : ''}\`} />;`,
    ];
    expect(ownCheckBoxes([box], [['a.css', '.mine { appearance: none; }']])).toHaveLength(1);
    // The words a class built elsewhere could be made of: whole where it reads whole.
    const loose = looseClasses('x.tsx', `const c = \`chip\${on ? ' on' : ''} zoom-\${size}\`;`);
    expect([[...loose.whole].sort(), [...loose.prefixes]]).toEqual([['chip', 'on'], ['zoom-']]);
    const own = looseClasses('x.tsx', `<i className={\`chip\${on ? ' on' : ''}\`} />`);
    expect([[...own.whole], [...own.prefixes]]).toEqual([[], []]);
  });

  it('[NFR-005] credits a touch rule only where it wins in the cascade (T-353)', () => {
    const short = (...sheets: string[]) => shortOnTouch(sheets);
    const mouse = '.a { min-height: var(--hit-target); }';
    const finger = '@media (pointer: coarse) { .a { min-height: 44px; } }';
    // A short rule of equal weight after the touch rule undoes it, in one sheet or the next.
    expect(short(`${finger} ${mouse}`)).toEqual(['.a']);
    expect(short(`${mouse} ${finger}`)).toEqual([]);
    expect(short(finger, mouse)).toEqual(['.a']);
    expect(short(mouse, finger)).toEqual([]);
    // Unless the touch rule is important or more specific, or a floor under a height.
    expect(short(`${finger.replace('44px', '44px !important')} ${mouse}`)).toEqual([]);
    expect(
      short(
        `@media (pointer: coarse) { .a { min-height: 44px; } } .a { height: var(--hit-target); }`,
      ),
    ).toEqual([]);
    expect(
      short(
        `@media (pointer: coarse) { .a { height: 44px; } } .a { min-height: var(--hit-target); }`,
      ),
    ).toEqual([]);
    expect(
      short(`@media (pointer: coarse) { .a { height: 44px; } } .a { height: var(--hit-target); }`),
    ).toEqual(['.a']);

    // Under another selector alike: one of equal weight counts only after the short rule, and a
    // min-height under a min-height counts only from a selector that wins.
    const page = jsxFacts(
      'x.tsx',
      '<div className="zoom"><button className="zoom-btn" type="button" /></div>',
      none,
    ).elements;
    const elsewhere = (css: string) =>
      shortOnTouch([css], (part) => isTargetSelector(part, new Set(['zoom-btn']), new Set()), page);
    const base = '.zoom-btn { height: 24px; }';
    const typed = '@media (pointer: coarse) { [type="button"] { height: 44px; } }';
    expect(elsewhere(`${base} ${typed}`)).toEqual([]);
    expect(elsewhere(`${typed} ${base}`)).toEqual(['.zoom-btn']);
    const floor = '.zoom-btn { min-height: 24px; }';
    expect(elsewhere(`${floor} @media (pointer: coarse) { button { min-height: 44px; } }`)).toEqual(
      ['.zoom-btn'],
    );
    expect(
      elsewhere(`${floor} @media (pointer: coarse) { .zoom button { min-height: 44px; } }`),
    ).toEqual([]);
  });

  it('[NFR-005] follows a component to where it is drawn for the elements around it (T-353)', () => {
    const covered =
      '.zoom-btn { height: 24px; } @media (pointer: coarse) { .zoom button { min-height: 44px; } }';
    const child = (body = '<button className="zoom-btn" type="button" />') =>
      `export function Zoomed() { return ${body}; }`;
    const place = (files: Record<string, string>) => {
      const sources = Object.entries(files);
      const facts = new Map(sources.map(([file, source]) => [file, jsxFacts(file, source, none)]));
      return elementsInPlace(sources, (file) => facts.get(file) as JsxFacts);
    };
    const short = (files: Record<string, string>, css = covered) =>
      shortOnTouch(
        [css],
        (part) => isTargetSelector(part, new Set(['zoom-btn']), new Set()),
        place(files),
      );
    const drawn = (wrapped: string, extra = '') =>
      `import { Zoomed } from './child';\n${extra}export function Bar() { return ${wrapped}; }`;
    const inZoom = drawn('<div className="zoom"><Zoomed /></div>');
    // The button's wrapper is in the file that draws its component, and in every place it does.
    expect(short({ 'a/child.tsx': child(), 'a/bar.tsx': inZoom })).toEqual([]);
    expect(
      short({
        'a/child.tsx': child(),
        'a/bar.tsx': inZoom,
        'a/other.tsx': drawn('<section><Zoomed /></section>'),
      }),
    ).toEqual(['.zoom-btn']);
    // Through a component that is drawn inside the wrapper in turn, and in its own file.
    expect(
      short({
        'a/child.tsx': child(),
        'a/middle.tsx': drawn('<span><Zoomed /></span>').replace('Bar', 'Middle'),
        'a/page.tsx':
          'import { Middle } from \'./middle\';\nexport const Page = () => <div className="zoom"><Middle /></div>;',
      }),
    ).toEqual([]);
    expect(
      short({
        'a/child.tsx': `${child()}\nexport const Bar = () => (<div className="zoom">{on ? <Zoomed /> : null}</div>);`,
      }),
    ).toEqual([]);
    // A list's items are drawn in place: only a portal's call puts them elsewhere.
    expect(
      short({
        'a/child.tsx': child(
          '<i>{ids.map((id) => <button key={id} className="zoom-btn" type="button" />)}</i>',
        ),
        'a/bar.tsx': inZoom,
      }),
    ).toEqual([]);
    // A child is a child of the element around its component only, not of one further out.
    const direct =
      '.zoom-btn { height: 24px; } @media (pointer: coarse) { .zoom > button { min-height: 44px; } }';
    expect(short({ 'a/child.tsx': child(), 'a/bar.tsx': inZoom }, direct)).toEqual([]);
    expect(
      short(
        {
          'a/child.tsx': child(),
          'a/bar.tsx': drawn('<div className="zoom"><span><Zoomed /></span></div>'),
        },
        direct,
      ),
    ).toEqual(['.zoom-btn']);
    // Not where it lands elsewhere or no one knows: a portal, JSX kept aside or made by a helper,
    // a component between, a component passed on by name or exported again, one drawn nowhere.
    for (const files of [
      {
        'a/child.tsx': child('createPortal(<button className="zoom-btn" />, document.body)'),
        'a/bar.tsx': inZoom,
      },
      {
        'a/child.tsx': child(
          '<div>{on && createPortal(<button className="zoom-btn" />, document.body)}</div>',
        ),
        'a/bar.tsx': inZoom,
      },
      {
        'a/child.tsx': child(
          '<div className="zoom">{on ? ReactDOM.createPortal(<span><button className="zoom-btn" /></span>, document.body) : null}</div>',
        ),
      },
      {
        'a/child.tsx':
          'export function Zoomed() { const b = <button className="zoom-btn" />; return <i>{b}</i>; }',
        'a/bar.tsx': inZoom,
      },
      {
        'a/child.tsx': child(),
        'a/bar.tsx': drawn('<div className="zoom"><Tip><Zoomed /></Tip></div>'),
      },
      {
        'a/child.tsx': child(),
        'a/bar.tsx': drawn('<div className="zoom"><Zoomed /></div>', 'const pages = [Zoomed];\n'),
      },
      {
        'a/child.tsx': child(),
        'a/bar.tsx': inZoom,
        'a/index.ts': "export { Zoomed } from './child';",
      },
      { 'a/child.tsx': child() },
    ]) {
      expect(short(files), JSON.stringify(files)).toEqual(['.zoom-btn']);
    }
  });

  it('[NFR-005] credits no touch rule that a later reset takes away again (T-356)', () => {
    const short = (...sheets: string[]) => shortOnTouch(sheets);
    const mouse = '.a { min-height: var(--hit-target); }';
    const floor = '@media (pointer: coarse) { .a { min-height: 44px; } }';
    expect(short(`${mouse} ${floor}`)).toEqual([]);
    // A floor taken away after it, in its sheet or a later one, by a rule that sizes nothing short.
    for (const reset of [
      '.a { min-height: auto; }',
      '.a { min-height: 0; }',
      '.a { min-block-size: initial; }',
    ]) {
      expect(short(`${mouse} ${floor} ${reset}`), reset).toEqual(['.a']);
      expect(short(`${mouse} ${floor}`, reset), reset).toEqual(['.a']);
      // Not before it, nor under a mouse or on paper only; on some touch screens is enough.
      expect(short(`${mouse} ${reset} ${floor}`), reset).toEqual([]);
      expect(short(`${mouse} ${floor} @media (pointer: fine) { ${reset} }`), reset).toEqual([]);
      expect(short(`${mouse} ${floor} @media print { ${reset} }`), reset).toEqual([]);
      expect(short(`${mouse} ${floor} @media (max-width: 767px) { ${reset} }`), reset).toEqual([
        '.a',
      ]);
    }
    // A finger's height over a short floor, put back to auto; a floor stands under any height.
    const tall = '@media (pointer: coarse) { .a { height: 44px; } }';
    expect(short(`${mouse} ${tall}`)).toEqual([]);
    expect(short(`${mouse} ${tall} .a { height: auto; }`)).toEqual(['.a']);
    expect(short(`${mouse} ${floor} .a { height: auto; }`)).toEqual([]);
    expect(short(`${mouse} ${tall} .a { height: 44px; }`)).toEqual([]);

    // On the elements of the app: a reset that reaches the same element, by the cascade.
    const read = (code: string) => {
      const facts = jsxFacts('x.tsx', code, none);
      return { elements: facts.elements, carry: mayCarryFrom([facts.loose]) };
    };
    const inZoom = read(
      '<div className="zoom"><button className="zoom-btn" type="button" /></div>',
    );
    const on = (css: string, { elements, carry } = inZoom) =>
      shortOnTouch(
        [css],
        (part) => isTargetSelector(part, new Set(['zoom-btn']), new Set()),
        elements,
        carry,
      );
    const base = '.zoom-btn { height: 24px; }';
    const touch = '@media (pointer: coarse) { .zoom-btn { min-height: 44px; } }';
    expect(on(`${base} ${touch}`)).toEqual([]);
    // More specific wins even before it; as specific wins after it; less specific or elsewhere not.
    expect(on(`${base} .zoom .zoom-btn { min-height: 0; } ${touch}`)).toEqual(['.zoom-btn']);
    expect(on(`${base} [type="button"] { min-height: auto; } ${touch}`)).toEqual([]);
    expect(on(`${base} ${touch} [type="button"] { min-height: auto; }`)).toEqual(['.zoom-btn']);
    expect(on(`${base} ${touch} button { min-height: 0; }`)).toEqual([]);
    expect(on(`${base} ${touch} .other { min-height: 0; }`)).toEqual([]);
    // A parent asked for by `>` that the element's parent in its file surely is not.
    expect(on(`${base} ${touch} .menu > .zoom-btn { min-height: 0; }`)).toEqual([]);
    expect(on(`${base} ${touch} .zoom > .zoom-btn { min-height: 0; }`)).toEqual(['.zoom-btn']);
    // A reset that a touch rule under its own selector answers takes nothing away (the calendar's
    // grip: `height: auto` in the month, and a finger's floor there on touch).
    const tipped = read(
      '<div className="zoom"><Tip><button className="zoom-btn" type="button" /></Tip></div>',
    );
    const height = `${base} @media (pointer: coarse) { .zoom-btn { height: 44px; } }`;
    const auto = '.zoom .zoom-btn { height: auto; }';
    const answered = '@media (pointer: coarse) { .zoom .zoom-btn { min-height: 44px; } }';
    expect(on(height, tipped)).toEqual([]);
    expect(on(`${height} ${auto}`, tipped)).toEqual(['.zoom-btn']);
    expect(on(`${height} ${auto} ${answered}`, tipped)).toEqual([]);
    // On an element whose class the runtime builds, only a reset under the touch rule's selector.
    const built = read(
      `<button className={cls} type="button" />; const cls = on ? 'zoom-btn' : 'other';`,
    );
    expect(on(`${base} ${touch}`, built)).toEqual([]);
    expect(on(`${base} ${touch} .other { min-height: 0; }`, built)).toEqual([]);
    expect(on(`${base} ${touch} .zoom-btn { min-height: 0; }`, built)).toEqual(['.zoom-btn']);
  });

  it('[NFR-005] reads a glass card inside a glass card per component, not per file (T-356)', () => {
    const glass = (files: Record<string, string>) => {
      const sources = Object.entries(files);
      const facts = new Map(sources.map(([file, source]) => [file, jsxFacts(file, source, none)]));
      return glassInGlass(sources, (file) => facts.get(file) as JsxFacts).map(
        ({ file, tag }) => `${file} ${tag}`,
      );
    };
    const cards = `
      export function Card() { return <section className="glass-card" />; }
      export function Fields() { return <label className="form-field" />; }
      export function Maybe({ nested }: P) { return <li className={nested ? 'well' : 'glass-card'} />; }
      export function Kept() { const card = <div className="glass-card" />; return <i>{card}</i>; }
      export function Outer() { return <div><Card /></div>; }
      export function Popped() { return createPortal(<div className="glass-card" />, document.body); }
      export function Wrapped() { return <TableScroller className="glass-card glass-scroller" />; }
      export function Toggled({ on }: P) { return <Wrapper className={on ? 'glass-card' : ''} />; }
    `;
    const page = (inner: string) =>
      `import { Card, Fields, Maybe, Kept, Outer, Popped, Wrapped, Toggled } from './cards';\nexport const Page = () => <div className="glass-card">${inner}</div>;`;
    // A component of a file that draws glass elsewhere draws none itself; what a portal draws
    // lands outside the card.
    expect(glass({ 'a/cards.tsx': cards, 'a/page.tsx': page('<Fields /><Popped />') })).toEqual([]);
    // One that draws one, under a condition, kept aside, through another component, or as the
    // className of a component of ours, does.
    for (const tag of ['Card', 'Maybe', 'Kept', 'Outer', 'Wrapped', 'Toggled']) {
      expect(glass({ 'a/cards.tsx': cards, 'a/page.tsx': page(`<${tag} />`) })).toEqual([
        `a/page.tsx ${tag}`,
      ]);
    }
    // JSX outside every component may be any of them's; a component of the same file counts too.
    const helper = `const card = () => <div className="glass-card" />;\nexport function Fields() { return <label />; }`;
    expect(glass({ 'a/cards.tsx': helper, 'a/page.tsx': page('<Fields />') })).toEqual([
      'a/page.tsx Fields',
    ]);
    expect(
      glass({
        'a/page.tsx': `function Inner() { return <section className="glass-card" />; }\nexport const Page = () => <div className="glass-card"><Inner /></div>;`,
      }),
    ).toEqual(['a/page.tsx Inner']);
  });

  it("[NFR-005] puts JSX held in a native element's attribute inside nothing of that element (T-356)", () => {
    const see = (code: string) => jsxFacts('x.tsx', code, none);
    const buttons = (code: string) => see(code).elements.filter((e) => e.tag === 'button');
    const [held] = buttons(
      '<div className="zoom" onClick={() => show(<span><button className="zoom-btn" /></span>)} />',
    );
    expect(held?.around.map((n) => n.tag)).toEqual(['span']);
    expect(surelyReaches('.zoom button', held as JsxElementFact)).toBe(false);
    // Its `children` is drawn inside it; a component's attribute is behind the component.
    const [child] = buttons('<div className="zoom" children={<button className="zoom-btn" />} />');
    expect(child?.around.map((n) => n.classes)).toEqual([['zoom']]);
    const [given] = buttons('<div className="zoom"><Tip body={<button />} /></div>');
    expect(given?.around.map((n) => n.tag)).toEqual(['Tip', 'div']);
    // Nor in a glass card around it, nor its component's, so not where that component is drawn.
    expect([
      ...see('<div className="glass-card" onClick={() => open(<Panel />)} />').renderedInGlass,
    ]).toEqual([]);
    const placed = (body: string) => {
      const sources = Object.entries({
        'a/child.tsx': `export function Zoomed() { return ${body}; }`,
        'a/bar.tsx':
          'import { Zoomed } from \'./child\';\nexport const Bar = () => <div className="zoom"><Zoomed /></div>;',
      });
      const facts = new Map(sources.map(([file, source]) => [file, jsxFacts(file, source, none)]));
      return shortOnTouch(
        [
          '.zoom-btn { height: 24px; } @media (pointer: coarse) { .zoom button { min-height: 44px; } }',
        ],
        (part) => isTargetSelector(part, new Set(['zoom-btn']), new Set()),
        elementsInPlace(sources, (file) => facts.get(file) as JsxFacts),
      );
    };
    expect(placed('<i><button className="zoom-btn" /></i>')).toEqual([]);
    expect(placed('<i onClick={() => show(<button className="zoom-btn" />)} />')).toEqual([
      '.zoom-btn',
    ]);
    // Nor around a control a component draws so with the className it is given.
    const pop = classPassers(
      'a/pop.tsx',
      'export function Pop({ className }: P) { return <div className="menu" onClick={() => show(<button className={className} />)} />; }',
    ).get('Pop');
    expect(pop?.inner.map((n) => n.tag)).toEqual(['Elsewhere']);
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
    // A story that asks for a touch screen but lacks the tag that runs it on one (T-328).
    const untagged = mkdtempSync(join(tmpdir(), 'touch-story-'));
    try {
      writeFileSync(
        join(untagged, 'Grip.stories.tsx'),
        'export const OnATouchScreen: Story = {\n  beforeEach: onARealTouchScreen,\n};\n',
      );
      expect(touchStoryProblem(untagged, 'Grip.stories.tsx#OnATouchScreen')).toContain(
        "has no tags: ['touch']",
      );
    } finally {
      rmSync(untagged, { recursive: true, force: true });
    }
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
    expect(LOAD_ORDER.length).toBeGreaterThan(20);
    const sheets = inLoadOrder.map(([file, source]) => [name(file), source] as const);
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

  it("[NFR-005] gives every target under a finger's height a finger's on touch (ADR-033, T-294)", () => {
    // In the order the app loads them, so a later rule of equal weight wins (T-353).
    const sources = inLoadOrder.map(([, source]) => source);
    const controls = new Set(scripts.flatMap((file) => [...factsOf(file).controls]));
    const grips = new Set(
      [...LISTED_GRIPS, ...cssGrips(sources)].flatMap((grip) => classesIn(subjectOf(grip))),
    );
    const elements = elementsInPlace(scriptSources, factsOf);
    const short = shortOnTouch(
      sources,
      (part) => isTargetSelector(part, controls, grips),
      elements,
      mayCarryFrom(scripts.map((file) => factsOf(file).loose)),
    );
    // What is let through for good is still there to let through, each with its reason.
    for (const selector of Object.keys(ALLOWED.shortTargets)) expect(short).toContain(selector);
    const found = new Map<string, string[]>();
    for (const selector of short.filter((s) => !(s in ALLOWED.shortTargets))) {
      const sheet = sheetSizing(selector);
      found.set(sheet, [...(found.get(sheet) ?? []), selector]);
    }
    expect(ratchet(found, OFFENDERS.shortTargets)).toEqual([]);
  });

  it('[NFR-007] lists every grip styled in a script for the touch checks too (T-294)', () => {
    const found = fromScripts((f) => unlistedInlineGrips(f.inlineGrips, LISTED_GRIPS));
    expect(ratchet(found, OFFENDERS.inlineGrips)).toEqual([]);
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
    const found = fromScripts((f) => f.nestedGlass.map((tag) => `<${tag}> in a glass-card`));
    expect(ratchet(found, {})).toEqual([]);
    // Per component (T-356): what is let through for good is still there, each with its reason.
    const across = glassInGlass(scriptSources, factsOf).map(
      ({ file, tag }) => `${name(file)} ${tag}`,
    );
    for (const item of Object.keys(ALLOWED.glassInGlass)) expect(across).toContain(item);
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

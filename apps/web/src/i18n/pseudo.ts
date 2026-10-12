import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';

/**
 * Pseudo-localisation: accents every letter, lengthens text by about a third and wraps the
 * message in brackets, while leaving ICU arguments, plural and select syntax and tags alone.
 * Running the app in `en-XA` shows which strings bypassed the catalogue and which layouts
 * break when translations run long.
 */
const ACCENTS: Record<string, string> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ď',
  e: 'é',
  f: 'ƒ',
  g: 'ğ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ĺ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ó',
  p: 'þ',
  q: ' q',
  r: 'ŕ',
  s: 'š',
  t: 'ť',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ď',
  E: 'É',
  F: 'Ƒ',
  G: 'Ğ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ĺ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ó',
  P: 'Þ',
  Q: 'Q',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ť',
  U: 'Ú',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};
ACCENTS.q = 'q';

/** Accents and lengthens one run of plain text. */
export function pseudoText(text: string): string {
  // Padding goes before trailing whitespace so words stay separated from what follows.
  const [, body = '', trailing = ''] = /^(.*?)(\s*)$/s.exec(text) ?? [];
  const accented = [...body].map((c) => ACCENTS[c] ?? c).join('');
  const letters = body.replace(/\s/g, '').length;
  return accented + '~'.repeat(Math.ceil(letters * 0.3)) + trailing;
}

function transform(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.map((el): MessageFormatElement => {
    switch (el.type) {
      case TYPE.literal:
        return { ...el, value: pseudoText(el.value) };
      case TYPE.plural:
      case TYPE.select:
        return {
          ...el,
          options: Object.fromEntries(
            Object.entries(el.options).map(([key, option]) => [
              key,
              { ...option, value: transform(option.value) },
            ]),
          ),
        };
      case TYPE.tag:
        return { ...el, children: transform(el.children) };
      default:
        return el;
    }
  });
}

export function pseudoLocalize(message: string): string {
  return `[${print(transform(parse(message)))}]`;
}

/** Writes an ICU message back from its tree. Covers what the catalogue uses. */
function print(elements: MessageFormatElement[]): string {
  return elements.map(printElement).join('');
}

function printElement(el: MessageFormatElement): string {
  switch (el.type) {
    case TYPE.literal:
      return /[{}<>#']/.test(el.value) ? `'${el.value.replace(/'/g, "''")}'` : el.value;
    case TYPE.argument:
      return `{${el.value}}`;
    case TYPE.number:
    case TYPE.date:
    case TYPE.time: {
      const kind = el.type === TYPE.number ? 'number' : el.type === TYPE.date ? 'date' : 'time';
      if (el.style && typeof el.style !== 'string') {
        throw new Error(
          `Skeleton styles are not supported in the catalogue: {${el.value}, ${kind}, ::...}`,
        );
      }
      return el.style ? `{${el.value}, ${kind}, ${el.style}}` : `{${el.value}, ${kind}}`;
    }
    case TYPE.select:
      return `{${el.value}, select, ${printOptions(el.options)}}`;
    case TYPE.plural: {
      const kind = el.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
      const offset = el.offset ? ` offset:${el.offset}` : '';
      return `{${el.value}, ${kind},${offset} ${printOptions(el.options)}}`;
    }
    case TYPE.pound:
      return '#';
    case TYPE.tag:
      return `<${el.value}>${print(el.children)}</${el.value}>`;
  }
}

function printOptions(options: Record<string, { value: MessageFormatElement[] }>): string {
  return Object.entries(options)
    .map(([key, option]) => `${key} {${print(option.value)}}`)
    .join(' ');
}

/** Argument names a message refers to, for checking that a translation kept them all. */
export function argumentNames(message: string): string[] {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const el of elements) {
      if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
      if (el.type === TYPE.tag) {
        walk(el.children);
        continue;
      }
      names.add(el.value);
      if (el.type === TYPE.plural || el.type === TYPE.select) {
        for (const option of Object.values(el.options)) walk(option.value);
      }
    }
  };
  walk(parse(message));
  return [...names].sort();
}

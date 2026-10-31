import type { AdapterRequest, ChatMessage, ContentPart } from './types';

/**
 * Redaction before data leaves the server (M1-077; IAM-022; ADR-100). Three kinds of rule:
 *
 * - patterns: built-in detectors for values that are sensitive wherever they appear (payment
 *   card numbers with a valid check digit, IBANs with a valid checksum, US social security
 *   numbers, email addresses);
 * - terms: words or phrases an administrator lists (a codename, a customer's name), matched
 *   without regard to case;
 * - values: the values of fields marked sensitive, which the code building a prompt from a
 *   ticket hands over with the request, so a value copied into free text is caught too.
 *
 * Every match becomes a placeholder naming what was there. Administrators cannot enter their
 * own regular expressions: a pattern runs over every prompt, and a careless one could take the
 * server down (catastrophic backtracking).
 */
export const REDACTION_PATTERNS = ['card-number', 'iban', 'us-ssn', 'email'] as const;
export type RedactionPattern = (typeof REDACTION_PATTERNS)[number];

/** On when an administrator has not chosen: values nobody wants sent anywhere. */
export const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[] = [
  'card-number',
  'iban',
  'us-ssn',
];

export interface SensitiveValue {
  value: string;
  /** What the placeholder says was there, such as the field's name. */
  label: string;
}

export interface RedactionRules {
  patterns: readonly RedactionPattern[];
  terms: readonly string[];
}

export const NO_REDACTION: RedactionRules = { patterns: [], terms: [] };

/** Shorter values are replaced in their own field only: in free text they would hit words. */
export const MIN_VALUE_LENGTH = 4;

export const placeholder = (what: string) => `[redacted: ${what}]`;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/ /g, '');
  if (iban.length < 15 || iban.length > 34) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of moved) {
    const code = char.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

interface Detector {
  label: string;
  regex: RegExp;
  accept?: (match: string) => boolean;
}

// Bounded, unnested quantifiers only: each runs in linear time.
const DETECTORS: Record<RedactionPattern, Detector> = {
  'card-number': {
    label: 'card number',
    regex: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    accept: (match) => luhn(match.replace(/[ -]/g, '')),
  },
  iban: {
    label: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
    accept: ibanValid,
  },
  'us-ssn': {
    label: 'national ID',
    regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  email: {
    label: 'email address',
    regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g,
  },
};

const escapeLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applies a set of rules to text and to whole requests. */
export class Redactor {
  private readonly literals: RegExp | null;
  private readonly labels = new Map<string, string>();
  private readonly detectors: Detector[];
  /** How many replacements the redactor made, for the audit row. */
  count = 0;

  constructor(rules: RedactionRules, values: readonly SensitiveValue[] = []) {
    this.detectors = rules.patterns.map((p) => DETECTORS[p]);
    const literals: string[] = [];
    for (const term of rules.terms) {
      const t = term.trim();
      if (t.length === 0) continue;
      this.labels.set(t.toLowerCase(), 'term');
      literals.push(t);
    }
    for (const { value, label } of values) {
      const v = value.trim();
      if (v.length < MIN_VALUE_LENGTH) continue;
      this.labels.set(v.toLowerCase(), label);
      literals.push(v);
    }
    // Longest first, so a value that contains another is replaced whole.
    literals.sort((a, b) => b.length - a.length);
    this.literals =
      literals.length > 0 ? new RegExp(literals.map(escapeLiteral).join('|'), 'gi') : null;
  }

  /** Whether the rules can change anything. */
  get active(): boolean {
    return this.literals !== null || this.detectors.length > 0;
  }

  text(input: string): string {
    if (!this.active || input.length === 0) return input;
    let out = input;
    if (this.literals) {
      out = out.replace(this.literals, (match) => {
        this.count += 1;
        return placeholder(this.labels.get(match.toLowerCase()) ?? 'term');
      });
    }
    for (const detector of this.detectors) {
      out = out.replace(detector.regex, (match) => {
        if (detector.accept && !detector.accept(match)) return match;
        this.count += 1;
        return placeholder(detector.label);
      });
    }
    return out;
  }

  private value(input: unknown): unknown {
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.value(v));
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, this.value(v)]),
      );
    }
    return input;
  }

  private part(part: ContentPart): ContentPart {
    switch (part.type) {
      case 'text':
        return { ...part, text: this.text(part.text) };
      case 'tool-result':
        return { ...part, content: this.text(part.content) };
      case 'tool-call':
        return { ...part, input: this.value(part.input) };
    }
  }

  private message(message: ChatMessage): ChatMessage {
    // A provider's own turn goes back exactly as it came (Claude checks its thinking blocks);
    // it holds only what the model wrote from text that was already redacted.
    if (message.native) return message;
    return {
      ...message,
      content:
        typeof message.content === 'string'
          ? this.text(message.content)
          : message.content.map((p) => this.part(p)),
    };
  }

  /** The request with every text a provider would receive redacted; unchanged when inactive. */
  request(request: AdapterRequest): AdapterRequest {
    if (!this.active) return request;
    return {
      ...request,
      system: this.text(request.system),
      ...(request.context !== undefined ? { context: this.text(request.context) } : {}),
      messages: request.messages.map((m) => this.message(m)),
    };
  }
}

/**
 * The formula syntax tree. Every node keeps the span of text it was read from, so a refusal
 * found after parsing (an unknown field, a type mismatch) still points at its place.
 */
export interface Span {
  start: number;
  end: number;
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'and'
  | 'or';

export type UnaryOp = '-' | '+' | 'not';

export type Node =
  | ({ kind: 'number'; value: number } & Span)
  | ({ kind: 'text'; value: string } & Span)
  | ({ kind: 'boolean'; value: boolean } & Span)
  | ({ kind: 'empty' } & Span)
  /** `{Name}`: a field of the ticket, by the name written between the braces. */
  | ({ kind: 'field'; name: string } & Span)
  /** `children` (the child tickets), or `children.{Name}` (a field's values on them). */
  | ({ kind: 'children'; field: ({ name: string } & Span) | null } & Span)
  | ({ kind: 'unary'; op: UnaryOp; operand: Node } & Span)
  | ({
      kind: 'binary';
      op: BinaryOp;
      left: Node;
      right: Node;
      opStart: number;
      opEnd: number;
    } & Span)
  /** A function call; `name` in lower case, `nameEnd` where the name stops. */
  | ({ kind: 'call'; name: string; args: Node[]; nameEnd: number } & Span);

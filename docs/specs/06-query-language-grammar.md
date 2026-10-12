---
spec: 06
title: "Native query language: grammar, canonical form and error recovery"
sources: docs/research/sources.md
accessed: 2026-10-12
attestation: own-words
---
# 06 Native query language: grammar, canonical form and error recovery

This is Taskmoor's own query language (M1-034, ADR-010). It is the language the product
stores, prints and documents. The Jira-compatible dialect described in file 01b, section 1, is
read by the same grammar: the dialect differs only in vocabulary (field and function names),
which the resolver maps, so every query in the dialect is also a query in this grammar. The
requirements are QRY-001 (grammar, positions, round trip), QRY-002 (operators), QRY-005
(history), QRY-006 (dates), QRY-009 (ordering) and QRY-013 (relative sprint tokens); this file
states the grammar those requirements refer to. The implementation is `packages/query`
(`scan`, `parseQuery`, `parseWithDiagnostics`, `printQuery`) and its contract is the
conformance suite in `packages/query/src/conformance`.

## 1. Lexical rules

Whitespace (spaces, tabs, line breaks) separates tokens and is otherwise ignored. A line break
is `\n`; `\r\n` counts as one.

| Token | Form |
|---|---|
| word | Starts with a letter, digit, `_`, `.`, `-` or `@`; continues with letters, digits, `_`, `.`, `-`, `@` and `/`. Covers names, keys (`ABC-12`), dates (`2026-01-31`, `2026/01/31`), durations (`-1w`), e-mail addresses and sprint tokens (`@current`) |
| number | A word that is an optional sign, digits and an optional decimal part (`8`, `-3`, `0.5`) |
| string | Text between double or single quotes; a backslash makes the next character literal (`"say \"hi\""`) |
| operator | `=` `!=` `<` `<=` `>` `>=` `~` `!~`; a sign directly followed by a digit starts a number instead |
| punctuation | `(` `)` `[` `]` `,` |

Keywords are words matched without regard to case: `AND`, `OR`, `NOT`, `IN`, `IS`, `EMPTY`,
`NULL`, `WAS`, `CHANGED`, `FROM`, `TO`, `BY`, `BEFORE`, `AFTER`, `ON`, `DURING`, `ORDER`,
`ASC`, `DESC`. A keyword that names an operator or predicate (`and`, `or`, `not`, `order`, `in`,
`is`, `was`, `changed`, `from`, `to`, `by`, `before`, `after`, `on`, `during`) cannot be an
unquoted field name or value; quote it to use it as one (`"order" = 1`, `status = "and"`).

## 2. Syntax

```
query      = [ expr ] [ order-by ]
expr       = and-expr { OR and-expr }
and-expr   = unary { AND unary }
unary      = NOT unary | "(" expr ")" | clause
clause     = field compare-op value
           | field [ NOT ] IN list
           | field IS [ NOT ] ( EMPTY | NULL )
           | field WAS [ NOT ] ( value | IN list ) { predicate }
           | field CHANGED { predicate }
predicate  = ( FROM | TO | BY | BEFORE | AFTER | ON | DURING ) ( value | "(" values ")" )
list       = "(" values ")" | function-call
values     = value { "," value }
value      = string | number | word | EMPTY | NULL | function-call
function-call = word "(" [ values ] ")"
field      = word | string | "cf" "[" number "]"
order-by   = ORDER BY sort { "," sort }
sort       = field [ ASC | DESC ]
compare-op = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~"
```

- Precedence is NOT over AND over OR; parentheses override it.
- A word value that matches a duration (`[+-]digits` followed by `m`, `h`, `d`, `w`, `M` or `y`)
  is a duration; `EMPTY` and `NULL` are the same value.
- `IN` and `WAS IN` take a list of at least one value; `IN someFunction()` takes the list a
  function returns.
- Without `ASC` or `DESC` a sort is ascending.
- Parentheses, `NOT` and function calls together nest at most 100 levels; a deeper query is
  refused with an error rather than exhausting the parser.

Typing is not part of the grammar: whether a field exists, whether an operator suits its type,
and what a value means are the resolver's rules (file 01b, sections 1.2 to 1.6).

## 3. Canonical form

`printQuery` writes a tree back as text that parses to the same tree. The canonical form:

- writes keywords in upper case, `IS NULL` as `IS EMPTY`, and every sort with its direction;
- double-quotes strings (escaping `"` and `\`), and quotes field names that are not plain words
  or that are reserved; custom fields by id print as `cf[n]`;
- prints a one-value `WAS IN (x)` as `WAS x` and a list made of one function as `IN f()`;
- adds parentheses only where precedence needs them, or where the same operator nests (so the
  tree keeps its shape when read back), and never around the whole condition.

## 4. Errors and recovery

Every error has a 0-based start and end offset, a 1-based line and column, a message, and the
tokens that would have been accepted at that point (for example `value`, `)`, `AND`). A
one-line query names the position in the message (`at position 10`); a multi-line query names
the line and column (`at line 3, column 1`).

`parseWithDiagnostics` never throws. It reports every independent mistake in one pass, in text
order and at most one per position, and returns a partial tree:

- a character that cannot start a token is reported once per run and skipped; a string without
  a closing quote runs to the end of the text and is reported;
- a clause that cannot be read is reported and skipped up to the next `AND`, `OR`, the `)` of
  an enclosing group, or `ORDER BY`, and is left out of the tree;
- inside a list, a mistake skips to the list's own `)` when there is one, otherwise to the next
  `AND`, `OR` or `ORDER BY`; the clause keeps the values read so far, and a list left empty
  drops the clause;
- a missing `)` is reported where it was expected and the group is kept; a stray token after a
  complete condition is reported and skipped, and what follows the next `AND` or `OR` is still
  read and joined;
- in `ORDER BY`, a missing `BY` is reported and the sorts are still read; a bad sort is skipped
  to the next comma.

The partial tree always prints as a valid query. `parseQuery` reports the first error of the
same pass, so both entry points agree.

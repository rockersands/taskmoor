import { describe, expect, it } from 'vitest';
import { stableJson } from './golden';
import { fc } from './property';

describe('stableJson', () => {
  it('sorts keys at every level and ends with a newline', () => {
    expect(stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('drops undefined properties like JSON.stringify does', () => {
    expect(stableJson({ a: undefined, b: 2 })).toBe('{\n  "b": 2\n}\n');
  });

  it('does not depend on key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(stableJson(reversed)).toBe(stableJson(record));
      }),
    );
  });

  it('round-trips through JSON.parse without changing', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = stableJson(value);
        expect(stableJson(JSON.parse(once))).toBe(once);
      }),
    );
  });
});

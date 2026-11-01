import { fenceUntrusted, neutraliseTags } from '@taskmoor/ai';

/**
 * Fences for a prompt made of several kinds of untrusted text (M1-079; IAM-023; ADR-108): no
 * piece may open or close an element of any of the prompt's kinds, not only its own, so text in
 * one element cannot pose as another (a comment's text opening a `<ticket>`).
 */
export function fences<const N extends string>(names: readonly N[]) {
  const inert = (text: string, except?: N) =>
    names.filter((n) => n !== except).reduce((t, name) => neutraliseTags(t, name), text);
  return {
    inert,
    fence: (name: N, attrs: Readonly<Record<string, string>>, text: string) =>
      fenceUntrusted(name, attrs, inert(text, name)),
  };
}

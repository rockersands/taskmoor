/**
 * A control's visible words and its accessible name, as WCAG 2.5.3 (Label in Name) compares them
 * and axe's `label-content-name-mismatch` does: lower case, punctuation dropped. `contained` says
 * whether the name holds the visible words together and in order, so someone who says what they
 * see ("click Delete ticket type") reaches the control. The name is the `aria-label` when there
 * is one (a repeated action named after its row, such as a DangerAction's), else the text.
 */
export function labelInName(element: Element): {
  visible: string;
  name: string;
  contained: boolean;
} {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const visible = words(element.textContent ?? '');
  const name = words(element.getAttribute('aria-label') ?? element.textContent ?? '');
  return { visible, name, contained: ` ${name} `.includes(` ${visible} `) };
}

/**
 * For stories: the text of an element as the browser laid it out, one string per line, from each
 * character's box. A line's end shows where the text was allowed to break.
 */
export function textLines(element: Element): string[] {
  const lines: { top: number; text: string }[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const box = range.getClientRects()[0];
      if (!box || box.height === 0) continue;
      const last = lines.at(-1);
      if (last && Math.abs(last.top - box.top) < box.height / 2) last.text += text[i];
      else lines.push({ top: box.top, text: text[i] as string });
    }
  }
  return lines.map((line) => line.text);
}

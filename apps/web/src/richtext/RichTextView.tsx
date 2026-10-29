import { isSafeHref, type PmJson, schema } from '@taskmoor/richtext';
import { DOMSerializer } from '@tiptap/pm/model';
import { useLayoutEffect, useRef } from 'react';

export interface RichTextViewProps {
  doc: PmJson;
  className?: string;
}

/**
 * A rich text document shown, not edited (M1-018): comments and other read-only text. The
 * shared schema builds the elements, so nothing is parsed as HTML; links keep only safe
 * addresses and open in a new tab. A document the schema refuses shows nothing.
 */
export function RichTextView({ doc, className }: RichTextViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.replaceChildren();
    try {
      const node = schema.nodeFromJSON(doc);
      const fragment = DOMSerializer.fromSchema(schema).serializeFragment(node.content, {
        document,
      });
      for (const link of fragment.querySelectorAll('a')) {
        const href = link.getAttribute('href') ?? '';
        if (!isSafeHref(href)) link.removeAttribute('href');
        link.setAttribute('rel', 'noopener noreferrer nofollow');
        link.setAttribute('target', '_blank');
      }
      root.append(fragment);
    } catch {
      // Nothing to show rather than half a document.
    }
  }, [doc]);
  return <div ref={ref} className={`rt-content rt-view${className ? ` ${className}` : ''}`} />;
}

import { isSafeHref, type PmJson, schema } from '@taskmoor/richtext';
import { DOMSerializer } from '@tiptap/pm/model';
import { useLayoutEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { showAttachment, useEditorTools } from './EditorTools';

export interface RichTextViewProps {
  doc: PmJson;
  className?: string;
}

/**
 * A rich text document shown, not edited (M1-018): comments and other read-only text. The
 * shared schema builds the elements, so nothing is parsed as HTML; links keep only safe
 * addresses and open in a new tab. Blocks that need the reader are finished here: a date in their
 * language, a reference to a ticket as a link in this app, a file as a link to it when the ticket
 * has one of that name, and a collapsible section with a word for its title when it has none. A
 * document the schema refuses shows nothing.
 */
export function RichTextView({ doc, className }: RichTextViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const { locale } = useIntl();
  const tools = useEditorTools();
  const untitled = t('richtext.expand.untitled');
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
        const ticket = link.getAttribute('data-ticket-ref');
        if (ticket !== null) {
          // A ticket of this app, in the same tab.
          if (link.hasAttribute('href')) {
            link.setAttribute('href', routeHref(`#/tickets/${encodeURIComponent(ticket)}`));
          }
          link.classList.add('rt-ticket-ref');
          continue;
        }
        const href = link.getAttribute('href') ?? '';
        if (!isSafeHref(href)) link.removeAttribute('href');
        link.setAttribute('rel', 'noopener noreferrer nofollow');
        link.setAttribute('target', '_blank');
      }
      for (const when of fragment.querySelectorAll<HTMLTimeElement>('time[data-date]')) {
        const ms = Number(when.getAttribute('data-date'));
        const date = Number.isFinite(ms) ? new Date(ms) : null;
        if (date && !Number.isNaN(date.getTime())) {
          when.dateTime = date.toISOString().slice(0, 10);
          when.textContent = new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeZone: 'UTC',
          }).format(date);
          when.classList.add('rt-date');
        }
      }
      for (const summary of fragment.querySelectorAll('summary')) {
        if (summary.textContent === '') summary.textContent = untitled;
      }
      const files = [...fragment.querySelectorAll<HTMLElement>('[data-attachment-ref]')];
      root.append(fragment);
      for (const file of files) {
        showAttachment(
          file,
          file.getAttribute('data-attachment-ref') ?? '',
          file.getAttribute('data-image') === 'true',
          tools,
          file.getAttribute('data-digest'),
        );
      }
    } catch {
      // Nothing to show rather than half a document.
    }
  }, [doc, locale, tools, untitled]);
  return <div ref={ref} className={`rt-content rt-view${className ? ` ${className}` : ''}`} />;
}

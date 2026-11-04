import { MAX_TITLE_LENGTH } from '@taskmoor/richtext';
import { type Editor, Extension, type NodeViewRenderer } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** The words a section shows in the editor, in the reader's language. */
export interface ExpandLabels {
  title: string;
  /** The toggle's name, for a section of this title: its state is `aria-expanded`. */
  toggle: (title: string) => string;
  show: string;
  hide: string;
  /** Next to a hidden section whose text someone changed meanwhile. */
  changed: string;
  /** What a section without a title is called. */
  untitled: string;
}

/** What the caret plugin reaches of a section, by the section's element. */
interface SectionControl {
  hidden: () => boolean;
  show: () => void;
  focusTitle: () => void;
}

const sections = new WeakMap<Node, SectionControl>();
let bodies = 0;

/**
 * What a section's title may not hold: the server takes it only as one line of text
 * (`isExpandTitle`), and a text field keeps a pasted tab.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** The first place a caret can stand from `pos` in a direction, if any. */
const caretFrom = (view: EditorView, pos: number, dir: 1 | -1) =>
  Selection.findFrom(view.state.doc.resolve(pos), dir, true);

/**
 * A collapsible section in the editor (NTF-014; ADR-120, TT-1): a toggle, its title as a field,
 * then its text. Hiding the text is the person's own view and is never written to the document,
 * so people editing together each keep theirs, and nobody's typing is hidden from anyone by
 * someone else. The hidden text still takes everyone's changes as they come; the section says
 * when it changed while hidden. The caret never stays in hidden text: hiding a section moves it
 * just past, and anything that puts the caret back inside (undo, a search, the arrow keys) shows
 * the text again. Wherever a document is only read, a section is the browser's own `details`.
 *
 * Keys: Enter, Escape or Down in the title go on to the text (past the section when it is
 * hidden); Up goes to the text before it; Up on the first line of a section's text goes to its
 * title, and Shift+Tab from there to the toggle, which Enter or Space works.
 */
export function expandNodeView(labels: () => ExpandLabels): NodeViewRenderer {
  return ({ node: first, getPos, editor }) => {
    let node: PmNode = first;
    let hidden = false;
    let changed = false;
    const at = () => (typeof getPos === 'function' ? getPos() : undefined);

    const dom = document.createElement('div');
    dom.className = 'rt-expand';
    const head = document.createElement('div');
    head.className = 'rt-expand-head';
    head.contentEditable = 'false';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'rt-expand-toggle';
    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'rt-expand-title';
    title.maxLength = MAX_TITLE_LENGTH;
    title.value = String(node.attrs.title ?? '');
    title.disabled = !editor.isEditable;
    const note = document.createElement('span');
    note.className = 'rt-expand-changed';
    const contentDOM = document.createElement('div');
    contentDOM.className = 'rt-expand-body';
    bodies += 1;
    contentDOM.id = `rt-expand-body-${bodies}`;
    note.id = `rt-expand-changed-${bodies}`;
    toggle.setAttribute('aria-controls', contentDOM.id);
    head.append(toggle, title, note);
    dom.append(head, contentDOM);

    const draw = () => {
      const words = labels();
      const name = String(node.attrs.title ?? '').trim() || words.untitled;
      toggle.setAttribute('aria-expanded', String(!hidden));
      toggle.setAttribute('aria-label', words.toggle(name));
      toggle.title = hidden ? words.show : words.hide;
      title.setAttribute('aria-label', words.title);
      dom.dataset.hidden = String(hidden);
      contentDOM.hidden = hidden;
      note.hidden = !(hidden && changed);
      note.textContent = words.changed;
      // The toggle says so too, for whoever reaches it by keyboard or with a screen reader.
      if (note.hidden) toggle.removeAttribute('aria-describedby');
      else toggle.setAttribute('aria-describedby', note.id);
    };

    /**
     * Puts the caret at `pos` going `dir`, in the editor, with the focus there too; when there is
     * no place that way and `back` is set, the nearest place the other way.
     */
    const caretTo = (pos: number, dir: 1 | -1, back = true) => {
      const view = editor.view;
      const found =
        caretFrom(view, pos, dir) ?? (back ? caretFrom(view, pos, dir === 1 ? -1 : 1) : null);
      if (!found) return;
      view.dispatch(view.state.tr.setSelection(found).scrollIntoView());
      view.focus();
    };

    const setHidden = (next: boolean) => {
      if (next === hidden) return;
      hidden = next;
      if (!hidden) changed = false;
      draw();
      const pos = at();
      if (!hidden || pos === undefined) return;
      // The caret does not stay in text nobody can see: it goes just past the section, or
      // before it at the end of a document, or onto the section itself.
      const view = editor.view;
      const { selection, doc } = view.state;
      const end = pos + node.nodeSize;
      if (selection.$head.pos <= pos || selection.$head.pos >= end) return;
      const away =
        caretFrom(view, end, 1) ?? caretFrom(view, pos, -1) ?? NodeSelection.create(doc, pos);
      view.dispatch(view.state.tr.setSelection(away));
    };

    toggle.addEventListener('click', () => setHidden(!hidden));
    title.addEventListener('input', () => {
      // A pasted tab or other control character becomes a space, as it is typed.
      const clean = title.value.replace(CONTROL_CHARACTERS, ' ');
      if (clean !== title.value) {
        const caret = title.selectionStart;
        title.value = clean;
        if (caret !== null) title.setSelectionRange(caret, caret);
      }
      const pos = at();
      if (pos === undefined) return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: clean }),
      );
    });
    title.addEventListener('keydown', (event) => {
      const pos = at();
      if (pos === undefined) return;
      const end = pos + node.nodeSize;
      if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        // Enter shows a hidden section's text and goes into it; the others go past it.
        if (hidden && event.key === 'Enter') setHidden(false);
        if (hidden) caretTo(end, 1);
        else caretTo(pos + 1, 1);
      } else if (event.key === 'ArrowUp') {
        // Up goes to the text before the section; with none, the title keeps the caret.
        event.preventDefault();
        event.stopPropagation();
        caretTo(pos, -1, false);
      }
    });

    sections.set(dom, {
      hidden: () => hidden,
      show: () => setHidden(false),
      focusTitle: () => title.focus(),
    });
    draw();

    return {
      dom,
      contentDOM,
      stopEvent: (event) => head.contains(event.target as Node),
      ignoreMutation: (mutation) => {
        if (mutation.type === 'selection') return false;
        if (head.contains(mutation.target)) return true;
        return (
          mutation.type === 'attributes' &&
          (mutation.target === dom || mutation.target === contentDOM)
        );
      },
      update: (next) => {
        if (next.type.name !== 'expand') return false;
        if (hidden && !next.content.eq(node.content)) changed = true;
        node = next;
        const value = String(next.attrs.title ?? '');
        if (title.value !== value) {
          // Someone else's change to the title keeps this person's caret where it was.
          const typing = title.ownerDocument.activeElement === title;
          const start = title.selectionStart;
          const stop = title.selectionEnd;
          title.value = value;
          if (typing && start !== null && stop !== null) {
            title.setSelectionRange(Math.min(start, value.length), Math.min(stop, value.length));
          }
        }
        draw();
        return true;
      },
      destroy: () => {
        sections.delete(dom);
      },
    };
  };
}

/** The sections around a position, innermost first, with where each starts. */
function sectionsAround(view: EditorView, pos: number): { pos: number; node: PmNode }[] {
  const $pos = view.state.doc.resolve(pos);
  const out: { pos: number; node: PmNode }[] = [];
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === 'expand') out.push({ pos: $pos.before(depth), node });
  }
  return out;
}

const control = (view: EditorView, pos: number) => {
  const element = view.nodeDOM(pos);
  return element ? sections.get(element) : undefined;
};

/**
 * Keeps the caret out of hidden text (TT-1): a selection that lands in a hidden section shows
 * it. Up on the first line of a section's text goes to the section's title.
 */
export const ExpandCaret = Extension.create({
  name: 'expandCaret',
  addKeyboardShortcuts() {
    return {
      ArrowUp: ({ editor }: { editor: Editor }) => {
        const { view, state } = editor;
        if (!state.selection.empty || !view.endOfTextblock('up')) return false;
        const { $head } = state.selection;
        const [inner] = sectionsAround(view, $head.pos);
        if (!inner) return false;
        const firstCaret = caretFrom(view, inner.pos + 1, 1);
        if (!firstCaret || firstCaret.$head.start() !== $head.start()) return false;
        const section = control(view, inner.pos);
        if (!section) return false;
        section.focusTitle();
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('expandCaret'),
        view: () => ({
          update: (view, before) => {
            if (view.state.selection.eq(before.selection)) return;
            for (const { pos } of sectionsAround(view, view.state.selection.$head.pos)) {
              const section = control(view, pos);
              if (section?.hidden()) section.show();
            }
          },
        }),
      }),
    ];
  },
});

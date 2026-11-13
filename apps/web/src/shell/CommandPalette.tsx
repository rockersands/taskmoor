import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { leaveMotion } from './motion';
import { OverlayLayer } from './OverlayLayer';
import { COMPACT_QUERY, TOUCH_QUERY, useMediaQuery } from './useMediaQuery';

export interface Command {
  id: string;
  labelId: MessageId;
  /** Values for the label's placeholders, such as a ticket key. */
  values?: Record<string, string | number>;
  /** Extra words the filter matches, for example a page's old name. */
  keywords?: string[];
  run: () => void;
}

interface CommandPaletteProps {
  commands: readonly Command[];
}

/** Ctrl+K or Cmd+K anywhere; also the search button in the top bar. */
export function isPaletteShortcut(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

/**
 * The command palette: a dialog with a combobox that filters commands as you type. Arrow keys
 * move, Enter runs, Escape closes and focus returns to where it was. It and its veil are drawn at
 * the end of the page's body (OverlayLayer): inside the top bar, the bar's blur held them both.
 */
export function CommandPalette({ commands }: CommandPaletteProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // A phone's palette is narrow and has no keyboard to press Ctrl K on (PL-49).
  const compact = useMediaQuery(COMPACT_QUERY);
  const touch = useMediaQuery(TOUCH_QUERY);
  const short = compact || touch;

  // Labels that start with what was typed come first, then labels that contain it, then
  // commands found by a keyword only; each group keeps the commands' order.
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rank = (command: Command, label: string) => {
      if (needle === '') return 0;
      const text = label.toLowerCase();
      if (text.startsWith(needle)) return 0;
      if (text.includes(needle)) return 1;
      return command.keywords?.some((k) => k.toLowerCase().includes(needle)) ? 2 : -1;
    };
    return commands
      .map((c) => {
        const label = t(c.labelId, c.values);
        return { command: c, label, rank: rank(c, label) };
      })
      .filter((item) => item.rank >= 0)
      .sort((a, b) => a.rank - b.rank);
  }, [commands, query, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      input.current?.focus();
    } else {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Cleared on the way out, so a reopened palette never shows the last query, however fast
  // the next keys come.
  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(0);
    trigger.current?.focus();
  };

  const run = (index: number) => {
    const item = items[index];
    if (!item) return;
    close();
    item.command.run();
  };

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((i) => Math.min(items.length - 1, i + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Enter':
        event.preventDefault();
        run(active);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  };

  const activeId = items[active] ? `${listId}-${items[active].command.id}` : undefined;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="palette-trigger"
        aria-label={t('shell.openCommandPalette')}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {/* A small phone shows the first word only; the name stays whole (TR-3). */}
        <span className="palette-trigger-label">{t('shell.openCommandPalette')}</span>
        <span className="palette-trigger-short" aria-hidden="true">
          {t('shell.openCommandPaletteShort')}
        </span>
      </button>

      {open && (
        <OverlayLayer>
          <button
            ref={leaveMotion}
            type="button"
            className="shell-backdrop palette-backdrop"
            aria-label={t('palette.close')}
            tabIndex={-1}
            onClick={close}
          />
          <div
            ref={leaveMotion}
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label={t('palette.title')}
          >
            <input
              ref={input}
              className="palette-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              {...(activeId ? { 'aria-activedescendant': activeId } : {})}
              placeholder={t(short ? 'palette.placeholderShort' : 'palette.placeholder')}
              aria-label={t('palette.title')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
            />
            {/* APG combobox pattern: focus stays on the input; aria-activedescendant names the option. */}
            <div
              id={listId}
              className="palette-list"
              role="listbox"
              aria-label={t('palette.results')}
            >
              {items.length === 0 && (
                <div
                  className="palette-empty"
                  role="option"
                  aria-selected="false"
                  aria-disabled="true"
                  tabIndex={-1}
                >
                  {t('palette.noResults')}
                </div>
              )}
              {items.map(({ command, label }, index) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox input
                // biome-ignore lint/a11y/useKeyWithMouseEvents: hover only moves the highlight
                <div
                  key={command.id}
                  id={`${listId}-${command.id}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  className={index === active ? 'palette-item is-active' : 'palette-item'}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(index)}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>
        </OverlayLayer>
      )}
    </>
  );
}

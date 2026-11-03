import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';
import { leaveMotion, useLeaveMotion } from './motion';

/** A click here keeps its own focus when it closes a popover: the person meant that control. */
const CONTROL =
  'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
/** The space kept between the panel and the edge of the screen. */
const GUTTER = 8;

export interface PopoverProps {
  /** What the button says. */
  label: ReactNode;
  /** The panel's name; on a phone also its heading. */
  title: string;
  /** Marks the button as holding something chosen: a tick beside a label that says how many. */
  on?: boolean;
  children: ReactNode;
}

/**
 * A button and the panel it opens over the page (ADR-114), so nothing under it moves. Escape and a
 * click outside close it and focus goes back to the button; moving focus away closes it too. It
 * stays in the page's order, so Tab goes from the button into the panel. Below 768 px the styles
 * dock the same panel at the bottom of the screen over a dimmed page, with a Done button.
 */
export function Popover({ label, title, on = false, children }: PopoverProps) {
  const t = useT();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelRef = useLeaveMotion(panel);

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.current?.contains(target)) return;
      close(!(target instanceof Element && target.closest(CONTROL)));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open, close]);

  // Keeps the panel inside the row it belongs to and on the screen, without any sideways scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = panel.current;
      const anchor = root.current;
      const row = anchor?.parentElement?.getBoundingClientRect();
      if (!box || !anchor || !row || row.width === 0) return;
      const right = Math.min(row.right, document.documentElement.clientWidth - GUTTER);
      box.style.setProperty('--popover-room', `${Math.max(0, right - row.left)}px`);
      const shift = right - (anchor.getBoundingClientRect().left + box.offsetWidth);
      box.style.setProperty('--popover-shift', `${Math.min(0, shift)}px`);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape and focus leaving, from anything inside
    <div
      ref={root}
      className="popover-anchor"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        // Only to a control: focus a press moved to anything else comes back on the click.
        if (next instanceof Element && next.matches(CONTROL) && !root.current?.contains(next)) {
          close(false);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="filter-chip filter-chip-menu"
        data-on={on || undefined}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open && (
        <>
          <button
            ref={leaveMotion}
            type="button"
            className="popover-scrim"
            tabIndex={-1}
            aria-label={t('popover.done')}
            onClick={() => close(true)}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: it holds any content, not only one set of fields */}
          <div ref={panelRef} id={panelId} className="popover" role="group" aria-label={title}>
            <div className="popover-head">
              <p className="popover-title">{title}</p>
              <button type="button" className="button-quiet" onClick={() => close(true)}>
                {t('popover.done')}
              </button>
            </div>
            {children}
          </div>
        </>
      )}
    </div>
  );
}

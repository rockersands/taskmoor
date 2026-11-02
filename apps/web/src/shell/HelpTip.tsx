import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { HelpIcon } from './icons';

interface HelpTipProps {
  /** What the explanation is about, as the button names it: "What is {name} for?". */
  name: string;
  children: ReactNode;
}

/**
 * "What is this for?" beside a page or panel title (ADR-112): a small round button that shows a
 * short explanation under it and hides it again. A disclosure, not a hover tooltip, so it works
 * by touch and keyboard; Escape and a click elsewhere close it.
 */
export function HelpTip({ name, children }: HelpTipProps) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={root}>
      <button
        ref={button}
        type="button"
        className="help-tip-button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t('help.about', { name })}
        title={t('help.about', { name })}
        onClick={() => setOpen((value) => !value)}
      >
        <HelpIcon width={16} height={16} />
      </button>
      <span id={id} className="help-tip-body" hidden={!open}>
        {children}
      </span>
    </span>
  );
}

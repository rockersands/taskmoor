import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { leaveMotion } from '../shell/motion';
import { useMenuButton } from '../shell/useMenuButton';

/** One file the menu offers: an address the server answers, or one the page makes. */
export type DownloadItem = { key: string; label: string; failed?: string } & (
  | { href: string }
  /** Makes the file and hands it to the browser; says its name. It rejects when it cannot. */
  | { make: () => Promise<string> }
);

export interface DownloadMenuProps {
  items: DownloadItem[];
  /** Lines beneath the button: what a file leaves out. */
  notes?: string[];
}

/**
 * Downloading a plan's view (T-089g; PLN-014): a short menu in the view's tools, with what each file
 * leaves out said beneath it. Files arrive by the browser's own download, and what happens is
 * announced in words, a slow image too.
 */
export function DownloadMenu({ items, notes = [] }: DownloadMenuProps) {
  const t = useT();
  const {
    open,
    openMenu,
    close,
    container,
    button,
    menu,
    buttonId,
    menuId,
    onButtonKeyDown,
    onMenuKeyDown,
  } = useMenuButton();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * A status line is read out when it changes, so the same words twice would say nothing the second
   * time: a space no one sees makes them new.
   */
  const say = (words: string) => setStatus((now) => (now === words ? `${words}\u00a0` : words));

  const run = async (item: DownloadItem & { make: () => Promise<string> }) => {
    close(true);
    setBusy(true);
    setProblem(null);
    say(t('plans.download.working', { label: item.label }));
    try {
      say(t('plans.download.done', { name: await item.make() }));
    } catch {
      setStatus('');
      setProblem(item.failed ?? t('plans.download.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-download">
      <div className="user-menu plan-download-menu" ref={container}>
        <button
          ref={button}
          id={buttonId}
          type="button"
          className="button-secondary"
          aria-haspopup="menu"
          aria-expanded={open}
          {...(open ? { 'aria-controls': menuId } : {})}
          // Not `disabled`: focus comes back to this button when the menu closes, and must stay.
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            if (open) close(false);
            else openMenu(true);
          }}
          onKeyDown={(event) => {
            if (!busy) onButtonKeyDown(event);
          }}
        >
          {t('plans.download')}
        </button>
        {open && (
          <div ref={leaveMotion} className="user-menu-popup">
            <div
              ref={menu}
              id={menuId}
              role="menu"
              aria-labelledby={buttonId}
              className="user-menu-list"
              onKeyDown={onMenuKeyDown}
            >
              {items.map((item) =>
                'href' in item ? (
                  <a
                    key={item.key}
                    role="menuitem"
                    tabIndex={-1}
                    className="user-menu-item"
                    href={item.href}
                    download
                    onClick={() => {
                      close(true);
                      setProblem(null);
                      say(t('plans.download.started', { label: item.label }));
                    }}
                  >
                    {item.label}
                  </a>
                ) : (
                  <button
                    key={item.key}
                    role="menuitem"
                    tabIndex={-1}
                    type="button"
                    className="user-menu-item"
                    onClick={() => void run(item)}
                  >
                    {item.label}
                  </button>
                ),
              )}
            </div>
          </div>
        )}
      </div>
      {notes.map((note) => (
        <p key={note} className="board-hint plan-download-note">
          {note}
        </p>
      ))}
      <p className="board-hint plan-download-note" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem plan-download-note" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

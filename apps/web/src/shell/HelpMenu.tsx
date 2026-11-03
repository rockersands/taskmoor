import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate } from '../routing/router';
import { TICKET_SHORTCUTS } from '../tickets/view/shortcuts';
import { leaveMotion } from './motion';
import { useMenuButton } from './useMenuButton';

/**
 * Help at the top bar (ADR-114), an APG menu button: the tutorials, and every keyboard shortcut in
 * one place. A person who is lost should find both from any page.
 */
export function HelpMenu() {
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
  const [showShortcuts, setShowShortcuts] = useState(false);

  return (
    <div className="user-menu help-menu" ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="icon-button help-menu-button"
        aria-label={t('help.menu')}
        title={t('help.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={() => (open ? close(false) : openMenu(true))}
        onKeyDown={onButtonKeyDown}
      >
        <span aria-hidden="true">?</span>
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
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className="user-menu-item"
              onClick={() => {
                close(true);
                navigate('#/settings/tutorials');
              }}
            >
              {t('help.tutorials')}
            </button>
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className="user-menu-item"
              onClick={() => {
                close(false);
                setShowShortcuts(true);
              }}
            >
              {t('help.shortcuts')}
            </button>
          </div>
        </div>
      )}
      {showShortcuts && (
        <ShortcutsDialog
          onClose={() => {
            setShowShortcuts(false);
            button.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  const everywhere = [
    ['Ctrl K', 'help.shortcuts.palette'],
    ['C', 'help.shortcuts.create'],
  ] as const;

  return (
    <div className="ticket-dialog-backdrop">
      <div
        ref={leaveMotion}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ticket-dialog help-shortcuts"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          // The close button is the only thing to reach, so Tab stays on it.
          if (event.key === 'Tab') {
            event.preventDefault();
            closeButton.current?.focus();
          }
        }}
      >
        <h2 id={titleId} className="ticket-section-title">
          {t('help.shortcuts')}
        </h2>
        <h3 className="help-shortcuts-group">{t('help.shortcuts.anywhere')}</h3>
        <dl className="ticket-shortcuts">
          {everywhere.map(([key, label]) => (
            <div key={key}>
              <dt>
                <kbd>{key}</kbd>
              </dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <h3 className="help-shortcuts-group">{t('help.shortcuts.ticket')}</h3>
        <dl className="ticket-shortcuts">
          {TICKET_SHORTCUTS.map(([key, label]) => (
            <div key={key}>
              <dt>
                <kbd>{key.toUpperCase()}</kbd>
              </dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <h3 className="help-shortcuts-group">{t('help.shortcuts.board')}</h3>
        <p className="page-note">{t('boards.keyboardHint')}</p>
        <div className="form-actions">
          <button ref={closeButton} type="button" className="button-primary" onClick={onClose}>
            {t('ticketView.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

import { type Ref, useImperativeHandle } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { useMenuButton } from '../../shell/useMenuButton';
import type { Transition } from './client';

interface StatusMenuProps {
  status: { id: number; name: string; stage: string };
  transitions: readonly Transition[];
  onChoose: (transition: Transition) => void;
  /** For the T shortcut, which goes to this control. */
  ref?: Ref<{ focus: () => void }>;
}

/**
 * A ticket's status as one control (the user's decision, ADR-116): the same words as the board's
 * columns, in the colour of its stage. Opening it lists where the ticket can go, and picking one
 * moves it at once. A ticket with nowhere to go shows its status as plain text.
 */
export function StatusMenu({ status, transitions, onChoose, ref }: StatusMenuProps) {
  const t = useT();
  const { open, openMenu, close, container, button, menu, buttonId, menuId, ...keys } =
    useMenuButton();
  useImperativeHandle(ref, () => ({ focus: () => button.current?.focus() }), [button]);

  const targets = transitions.filter((to) => to.to.id !== status.id);
  if (targets.length === 0) {
    return (
      <span className="ticket-status" data-stage={status.stage}>
        {status.name}
      </span>
    );
  }
  // Two ways into one status (an administrator's workflow) are told apart by their names.
  const repeated = (to: Transition) => targets.filter((o) => o.to.id === to.to.id).length > 1;

  return (
    <div className="status-menu" ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="ticket-status status-menu-button"
        data-stage={status.stage}
        aria-label={t('ticketView.status', { status: status.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={() => (open ? close(false) : openMenu(true))}
        onKeyDown={keys.onButtonKeyDown}
      >
        {status.name}
        <span className="status-menu-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="user-menu-popup status-menu-popup">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={keys.onMenuKeyDown}
          >
            {targets.map((to) => (
              <button
                key={to.id}
                role="menuitem"
                tabIndex={-1}
                type="button"
                className="user-menu-item status-menu-item"
                data-stage={to.to.stage}
                onClick={() => {
                  close(true);
                  onChoose(to);
                }}
              >
                {repeated(to)
                  ? t('ticketView.statusVia', { status: to.to.name, name: to.name })
                  : to.to.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

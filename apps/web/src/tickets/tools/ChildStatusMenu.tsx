import { type KeyboardEvent, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { leaveMotion } from '../../shell/motion';
import { useMenuButton } from '../../shell/useMenuButton';
import type { Transition } from '../view/client';
import type { ChildTicket } from './client';

export interface ChildStatusMenuProps {
  child: ChildTicket;
  /** Where the subticket can go from its status now, as its own page reads it. */
  load: (id: number) => Promise<Transition[]>;
  onChoose: (child: ChildTicket, to: Transition) => void;
}

/** Whether a move leads where the subticket already is. */
const stays = (child: ChildTicket, to: Transition) =>
  child.status.id === undefined ? to.to.name === child.status.name : to.to.id === child.status.id;

/**
 * A subticket's status in its parent's list, as a menu of where it can go (CORE-032; ADR-120,
 * TT-6): the ticket page's own control, in the same words and colours. Where it can go is read
 * as the menu opens, so it is never out of date and a long list asks nothing until it is used.
 * The workflow, its conditions and the person's rights all apply, as on the ticket's page; a
 * status with nowhere to go says so in the menu.
 */
export function ChildStatusMenu({ child, load, onChoose }: ChildStatusMenuProps) {
  const t = useT();
  const { open, openMenu, close, container, button, menu, buttonId, menuId, onMenuKeyDown } =
    useMenuButton();
  const [targets, setTargets] = useState<Transition[]>([]);
  const [reading, setReading] = useState(false);
  const asking = useRef(false);

  /** Reads where it can go, then opens on the first or the last. */
  const show = async (first: boolean) => {
    if (asking.current) return;
    asking.current = true;
    setReading(true);
    try {
      setTargets((await load(child.id)).filter((to) => !stays(child, to)));
    } catch {
      setTargets([]);
    } finally {
      asking.current = false;
      setReading(false);
    }
    openMenu(first);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void show(event.key === 'ArrowDown');
    }
  };
  // Two ways into one status (an administrator's workflow) are told apart by their names.
  const repeated = (to: Transition) => targets.filter((o) => o.to.id === to.to.id).length > 1;

  return (
    <div className="status-menu ticket-child-status-menu" ref={container}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="ticket-status status-menu-button ticket-child-status"
        data-stage={child.status.stage}
        aria-label={t('ticketTools.subtickets.statusOf', {
          key: child.key,
          status: child.status.name,
        })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={reading || undefined}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={() => (open ? close(false) : void show(true))}
        onKeyDown={onKeyDown}
      >
        {child.status.name}
        <span className="status-menu-caret" aria-hidden="true" />
      </button>
      {open && (
        <div ref={leaveMotion} className="user-menu-popup status-menu-popup">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={onMenuKeyDown}
          >
            {targets.length === 0 ? (
              <button
                role="menuitem"
                tabIndex={-1}
                type="button"
                aria-disabled="true"
                className="user-menu-item"
              >
                {t('ticketTools.subtickets.nowhere', { status: child.status.name })}
              </button>
            ) : (
              targets.map((to) => (
                <button
                  key={to.id}
                  role="menuitem"
                  tabIndex={-1}
                  type="button"
                  className="user-menu-item status-menu-item"
                  data-stage={to.to.stage}
                  onClick={() => {
                    close(true);
                    onChoose(child, to);
                  }}
                >
                  {repeated(to)
                    ? t('ticketView.statusVia', { status: to.to.name, name: to.name })
                    : to.to.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

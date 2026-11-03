import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import {
  closeOverlay,
  currentRoute,
  FULL_PAGE_ATTRIBUTE,
  overlayDepth,
  pressedLink,
  routeHref,
  useOverlayRoute,
} from '../../routing/router';
import { RequireSession } from '../../session/RequireSession';
import { ModalDialog } from '../../shell/ModalDialog';
import { DraftDialog, hasDraft } from './drafts';
import { TICKET_POPUP_CLASS, TicketView, type TicketViewProps } from './TicketPage';

export type TicketPopupProps = Omit<TicketViewProps, 'ticket' | 'popup'>;

/** The ticket in an address (#/tickets/<key>?comment=<id>), decoded. */
function ticketOf(route: string): string {
  const segment = route.replace(/^#\/tickets\//, '').split(/[/?]/)[0] ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Something inside the pop-up that an Escape belongs to: a dialog, a menu, a list, a tip. */
const OPEN_INSIDE =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .help-tip-body:not([hidden]), .popover';

/**
 * The ticket pop-up: the ticket view over the page, at the ticket's own address (the router's
 * comment says how the address and history work). One view: anything added to the ticket view
 * shows here too. It renders nothing while no ticket is over the page, and the page beneath stays
 * mounted either way.
 *
 * Escape closes what is open inside first: a menu, a dialog, then a field (the first Escape only
 * leaves it), and the pop-up last. Unsaved text is never lost in silence: closing, a link inside
 * and the browser's Back all stop and ask first. Back cannot be refused, so it steps forward again
 * to ask, and goes back if the person says to discard.
 */
export function TicketPopup(props: TicketPopupProps) {
  const route = useOverlayRoute();
  const depth = overlayDepth();
  const [drawn, setDrawn] = useState(
    route === null ? null : { route, depth, page: currentRoute() },
  );
  const [asking, setAsking] = useState<(() => void) | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const letGo = useRef(false);
  const closing = useRef(false);

  const moved = route !== (drawn?.route ?? null) || depth !== (drawn?.depth ?? 0);
  const holding =
    moved &&
    drawn !== null &&
    depth !== drawn.depth &&
    !letGo.current &&
    currentRoute() === drawn.page &&
    hasDraft(body.current);
  if (moved && !holding) {
    setDrawn(route === null ? null : { route, depth, page: currentRoute() });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new ticket, or none, starts afresh
  useEffect(() => {
    letGo.current = false;
    closing.current = false;
    setAsking(null);
  }, [drawn?.route, drawn?.depth]);

  // Back or Forward with a draft open: to where the draft is, then ask.
  useEffect(() => {
    if (!holding || !drawn) return;
    const step = depth - drawn.depth;
    window.history.go(-step);
    setAsking(() => () => {
      letGo.current = true;
      window.history.go(step);
    });
  }, [holding, depth, drawn]);

  const leave = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    letGo.current = true;
    closeOverlay();
  }, []);
  const requestClose = useCallback(() => {
    if (hasDraft(body.current)) setAsking(() => leave);
    else leave();
  }, [leave]);

  if (!drawn) return null;
  return (
    <TicketPopupFrame
      {...props}
      route={drawn.route}
      body={body}
      asking={asking}
      onAskAgain={setAsking}
      onClose={requestClose}
      letGo={letGo}
    />
  );
}

function TicketPopupFrame({
  route,
  body,
  asking,
  onAskAgain,
  onClose,
  letGo,
  ...clients
}: TicketPopupProps & {
  route: string;
  body: React.RefObject<HTMLDivElement | null>;
  asking: (() => void) | null;
  onAskAgain: (proceed: (() => void) | null) => void;
  onClose: () => void;
  letGo: React.RefObject<boolean>;
}) {
  const t = useT();
  const labelId = useId();
  const ticket = ticketOf(route);
  const [title, setTitle] = useState<{ of: string; key: string; summary: string } | null>(null);
  const firstRoute = useRef(route);
  const fullPage = routeHref(`#/tickets/${encodeURIComponent(ticket)}`);

  // Moved to another ticket from inside: start at its top, with focus in the pop-up.
  const shown = useRef(ticket);
  useEffect(() => {
    if (shown.current === ticket) return;
    shown.current = ticket;
    const box = body.current?.closest<HTMLElement>('[role="dialog"]');
    box?.scrollTo?.({ top: 0 });
    box?.focus();
  }, [ticket, body]);

  const onEscape = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Taken by what has the focus: the rich text editor, for one.
    if (event.defaultPrevented) return;
    const box = event.currentTarget;
    const target = event.target as HTMLElement;
    if (box.querySelector(OPEN_INSIDE)) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.isContentEditable || target.matches('input, textarea, select')) box.focus();
    else onClose();
  };

  // A row may have been drawn again (a card that moved column), or the page read again after a
  // reload: the link to the same place then takes focus.
  const restoreFocus = (opener: HTMLElement | null) => {
    if (opener?.isConnected && opener !== document.body) {
      opener.focus();
      return;
    }
    const href = opener?.getAttribute('href') ?? routeHref(firstRoute.current);
    const links = document.querySelectorAll<HTMLElement>('a[href]');
    for (const link of links) {
      if (link.getAttribute('href') === href) {
        link.focus();
        return;
      }
    }
  };

  const onClickCapture = (event: React.MouseEvent) => {
    if (letGo.current) return;
    const pressed = pressedLink(event.nativeEvent);
    if (!pressed || !hasDraft(body.current)) return;
    event.preventDefault();
    event.stopPropagation();
    onAskAgain(() => () => {
      letGo.current = true;
      (pressed.anchor as HTMLElement).click();
      window.setTimeout(() => {
        letGo.current = false;
      }, 0);
    });
  };

  return (
    <ModalDialog
      onClose={onClose}
      onEscape={onEscape}
      restoreFocus={restoreFocus}
      labelledBy={labelId}
      closeLabel={t('ticketPopup.closeBackdrop')}
      className={TICKET_POPUP_CLASS}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only asks before a link inside leaves a draft */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on a link arrives as a click */}
      <div onClickCapture={onClickCapture}>
        <span id={labelId} className="visually-hidden">
          {title?.of === ticket
            ? t('ticketPage.title', { key: title.key, summary: title.summary })
            : ticket}
        </span>
        <div className="ticket-popup-bar">
          <a
            className="button-secondary ticket-action"
            href={fullPage}
            {...{ [FULL_PAGE_ATTRIBUTE]: '' }}
          >
            {t('ticketPopup.openFull')}
          </a>
          <button type="button" className="button-secondary ticket-action" onClick={onClose}>
            {t('ticketView.close')}
          </button>
        </div>
        <div ref={body} className="ticket-popup-body">
          <RequireSession>
            <TicketView
              key={ticket}
              ticket={ticket}
              popup={{ onTicket: (shownTicket) => setTitle({ of: ticket, ...shownTicket }) }}
              {...clients}
            />
          </RequireSession>
        </div>
      </div>
      {asking && (
        <DraftDialog
          onKeep={() => onAskAgain(null)}
          onDiscard={() => {
            const proceed = asking;
            onAskAgain(null);
            proceed();
          }}
        />
      )}
    </ModalDialog>
  );
}

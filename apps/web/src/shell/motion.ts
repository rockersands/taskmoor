import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

/**
 * What CSS alone cannot do for the watery motion (ADR-114, section 11; the rest is motion.css):
 * animate a surface React has already removed, and replay an animation on an element that stays.
 * Nothing here delays anything: state, focus and the page move on at once.
 */

/** A backdrop fades rather than melts: given its own ref, or the parent of the surface. */
const SCRIM =
  '.shell-backdrop, .popover-scrim, .ticket-dialog-backdrop, .attachment-preview-backdrop';
/** A copy is removed by this time at the latest, if its animation never ends. */
const LONGEST = 400;

const wantsMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches === true;

interface Picture {
  className: string;
  style: string;
  box: DOMRect;
  kind: 'motion-collapse' | 'motion-fade-out';
}

function pictureOf(node: Element, kind: Picture['kind']): Picture | null {
  const box = node.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  return {
    className: node.className,
    style: node instanceof HTMLElement ? node.style.cssText : '',
    box,
    kind,
  };
}

/** An empty copy, hidden from assistive technology, over the place the surface was. */
function melt({ className, style, box, kind }: Picture) {
  const ghost = document.createElement('div');
  ghost.className = `${className} ${kind}`;
  ghost.style.cssText = style;
  ghost.setAttribute('aria-hidden', 'true');
  const place = {
    position: 'fixed',
    top: `${box.top}px`,
    left: `${box.left}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
    'min-width': '0',
    'max-width': 'none',
    'max-height': 'none',
    'box-sizing': 'border-box',
    'pointer-events': 'none',
  };
  for (const [name, value] of Object.entries(place)) {
    ghost.style.setProperty(name, value, 'important');
  }
  const remove = () => ghost.remove();
  ghost.addEventListener('animationend', remove, { once: true });
  window.setTimeout(remove, LONGEST);
  document.body.append(ghost);
}

/**
 * A ref for a surface or backdrop that is shown and then removed. As React removes it, an empty
 * copy melts in its place. The surface itself is gone at once, for tests, screen readers and focus
 * alike. Only the box is copied, so no text or id appears twice.
 */
export function leaveMotion(node: HTMLElement | null) {
  if (!node) return undefined;
  return () => {
    if (!wantsMotion()) return;
    // Read now, while it is still on the page.
    const parent = node.parentElement;
    const pictures = [
      parent?.matches(SCRIM) ? pictureOf(parent, 'motion-fade-out') : null,
      pictureOf(node, node.matches(SCRIM) ? 'motion-fade-out' : 'motion-collapse'),
    ].filter((p): p is Picture => p !== null);
    // Development's strict mode detaches a ref and attaches it again: the surface is still here.
    queueMicrotask(() => {
      if (!node.isConnected) pictures.forEach(melt);
    });
  };
}

/** `leaveMotion` for a surface whose component also keeps a ref to it. */
export function useLeaveMotion<T extends HTMLElement>(ref: RefObject<T | null>) {
  return useCallback(
    (node: T | null) => {
      ref.current = node;
      const leave = leaveMotion(node);
      return () => {
        ref.current = null;
        leave?.();
      };
    },
    [ref],
  );
}

/**
 * Plays one of the classes of motion.css once on an element that stays on the page, starting it
 * again if it is still running. The class goes when it ends, so nothing keeps a layer or a
 * containing block afterwards.
 */
export function playMotion(element: Element, name: string) {
  if (element.classList.contains(name)) {
    for (const animation of element.getAnimations?.() ?? []) {
      animation.cancel();
      animation.play();
    }
    return;
  }
  element.classList.add(name);
  const done = (event: Event) => {
    if (event.target !== element) return;
    element.classList.remove(name);
    element.removeEventListener('animationend', done);
    element.removeEventListener('animationcancel', done);
  };
  element.addEventListener('animationend', done);
  element.addEventListener('animationcancel', done);
}

/** A ref for a region that plays `name` when it first shows and whenever `change` changes. */
export function useMotionOnChange<T extends HTMLElement>(name: string, change: unknown) {
  const ref = useRef<T>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of `change` is the signal to play
  useLayoutEffect(() => {
    if (ref.current) playMotion(ref.current, name);
  }, [name, change]);
  return ref;
}

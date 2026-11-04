import { type MutableRefObject, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';

export interface CoachCardProps {
  sectionTitle: string;
  title: string;
  body: string;
  /** The step's place, from 0, and how many steps the section has. */
  index: number;
  count: number;
  /** The step moves on by itself once the person has done what it asks. */
  waiting: boolean;
  /** A route to the page the step happens on, when the person is elsewhere. */
  goThere: string | null;
  /** The last step: the page of what the section made, to keep it or delete it. */
  made: string | null;
  /** The card takes focus whenever this changes (from 1 up); 0 leaves focus where it is. */
  focusKey: number;
  cardRef?: MutableRefObject<HTMLDivElement | null>;
  onBack: () => void;
  onNext: () => void;
  onPause: () => void;
  onSkip: () => void;
}

/**
 * The tutorial's coach card (ADR-115): a non-modal dialog floating over the page, which stays
 * usable around it. It shows the step, why it matters and Back, Next, Pause and Skip section, with
 * a step counter. It takes focus when a step starts from its buttons, says each new step through a
 * status line, pauses on Escape and traps nothing. On a phone it docks at the bottom.
 */
export function CoachCard({
  sectionTitle,
  title,
  body,
  index,
  count,
  waiting,
  goThere,
  made,
  focusKey,
  cardRef,
  onBack,
  onNext,
  onPause,
  onSkip,
}: CoachCardProps) {
  const t = useT();
  const id = useId();
  const own = useRef<HTMLDivElement | null>(null);
  const last = index >= count - 1;
  const progress = t('tutorial.coach.progress', {
    section: sectionTitle,
    step: index + 1,
    count,
  });

  useEffect(() => {
    if (focusKey > 0) own.current?.focus();
  }, [focusKey]);

  return (
    <div
      ref={(node) => {
        own.current = node;
        if (cardRef) cardRef.current = node;
      }}
      className="coach-card motion-swell"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onPause();
      }}
    >
      <p className="coach-eyebrow">{progress}</p>
      <h2 id={`${id}-title`} className="coach-title">
        {title}
      </h2>
      <p id={`${id}-body`} className="coach-body">
        {body}
      </p>
      {waiting && <p className="coach-waiting">{t('tutorial.coach.waiting')}</p>}
      {(goThere || made) && (
        <p className="coach-links">
          {goThere && <a href={routeHref(goThere)}>{t('tutorial.coach.goThere')}</a>}
          {made && <a href={routeHref(made)}>{t('tutorial.coach.openMade')}</a>}
        </p>
      )}
      <div className="coach-actions">
        <button type="button" className="button-secondary" disabled={index === 0} onClick={onBack}>
          {t('tutorial.coach.back')}
        </button>
        <button type="button" className="button-primary" onClick={onNext}>
          {last ? t('tutorial.coach.finish') : t('tutorial.coach.next')}
        </button>
        <button type="button" className="button-quiet" onClick={onPause}>
          {t('tutorial.coach.pause')}
        </button>
        <button type="button" className="button-quiet" onClick={onSkip}>
          {t('tutorial.coach.skip')}
        </button>
      </div>
      <p role="status" className="visually-hidden">
        {t('tutorial.coach.announce', { progress, title })}
      </p>
    </div>
  );
}

export interface PausedCoachProps {
  sectionTitle: string;
  index: number;
  count: number;
  onResume: () => void;
  onClose: () => void;
}

/** A paused tutorial (ADR-115): its place kept, one press from going on, or closed for now. */
export function PausedCoach({ sectionTitle, index, count, onResume, onClose }: PausedCoachProps) {
  const t = useT();
  const id = useId();
  return (
    <section className="coach-paused glass-card motion-settle" aria-labelledby={id}>
      <p id={id} className="coach-paused-text">
        {t('tutorial.coach.paused', { section: sectionTitle, step: index + 1, count })}
      </p>
      <div className="coach-paused-actions">
        <button type="button" className="button-primary" onClick={onResume}>
          {t('tutorial.coach.resume')}
        </button>
        <button type="button" className="button-quiet" onClick={onClose}>
          {t('tutorial.coach.close')}
        </button>
      </div>
    </section>
  );
}

/** The first element with this marker that is drawn; markers can repeat (a drawer, a header). */
export function findTarget(marker: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tutorial="${marker}"]`)) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return el;
  }
  return null;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const MARGIN = 24;
const RING = 6;

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

/** Where the card sits so it does not cover the control: its corner, the other one, or the top. */
function placeFor(target: Box, card: Box): 'end' | 'start' | 'top' {
  const rtl = document.documentElement.dir === 'rtl';
  const width = window.innerWidth;
  const height = window.innerHeight;
  const endLeft = rtl ? MARGIN : width - card.width - MARGIN;
  const startLeft = rtl ? width - card.width - MARGIN : MARGIN;
  const bottom = height - card.height - MARGIN;
  const near = {
    top: target.top - RING,
    left: target.left - RING,
    width: target.width + 2 * RING,
    height: target.height + 2 * RING,
  };
  const at = (left: number, top: number): Box => ({
    left,
    top,
    width: card.width,
    height: card.height,
  });
  if (!overlaps(near, at(endLeft, bottom))) return 'end';
  if (!overlaps(near, at(startLeft, bottom))) return 'start';
  return 'top';
}

/**
 * The ring around the control the step is about, with the rest of the page dimmed but still
 * usable (nothing here takes a click). It follows the control as the page scrolls or changes,
 * scrolls it into view once, moves the card off it, and on a phone keeps room for the docked card.
 */
export function Spotlight({
  target,
  card,
}: {
  target: string | undefined;
  card: MutableRefObject<HTMLDivElement | null>;
}) {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    let shown = false;
    const measure = () => {
      const el = target ? findTarget(target) : null;
      const rect = el?.getBoundingClientRect() ?? null;
      if (el && rect && !shown) {
        shown = true;
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        }
      }
      setBox((previous) => {
        if (!rect) return null;
        const next = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        return previous &&
          previous.top === next.top &&
          previous.left === next.left &&
          previous.width === next.width &&
          previous.height === next.height
          ? previous
          : next;
      });
      const node = card.current;
      if (!node) return;
      const cardBox = node.getBoundingClientRect();
      // The docked card's height, so the page can scroll what it covers into view above it.
      document.documentElement.style.setProperty('--coach-space', `${Math.ceil(cardBox.height)}px`);
      const place = rect && window.innerWidth >= 768 ? placeFor(rect, cardBox) : 'end';
      if (place === 'end') delete node.dataset.place;
      else node.dataset.place = place;
    };
    measure();
    const timer = window.setInterval(measure, 250);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [target, card]);
  if (!box) return null;
  return (
    <div
      className="coach-ring"
      aria-hidden="true"
      style={{
        top: `${box.top - RING}px`,
        left: `${box.left - RING}px`,
        width: `${box.width + 2 * RING}px`,
        height: `${box.height + 2 * RING}px`,
      }}
    />
  );
}

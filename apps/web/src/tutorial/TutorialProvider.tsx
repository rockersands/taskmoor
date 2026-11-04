import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { onApiChange } from '../api/changes';
import { useT } from '../i18n/I18nProvider';
import {
  currentRoute,
  onRouteChange,
  overlayRoute,
  useOverlayRoute,
  useRoute,
} from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { CoachCard, PausedCoach, Spotlight } from './CoachCard';
import { type SectionProgress, type TutorialClient, tutorialClient } from './client';
import {
  audienceOf,
  mayTake,
  sectionById,
  type TutorialAudience,
  type TutorialSectionId,
} from './sections';
import {
  remember,
  type StepDone,
  stepBodyId,
  stepsFor,
  stepTitleId,
  type TutorialMemory,
} from './steps';

/**
 * A run of one or more sections in this tab: the first of `queue` is the one showing. It belongs
 * to the person who started it, so someone else signing in on this tab is not led through it.
 */
interface Run {
  user: number;
  queue: TutorialSectionId[];
  step: number;
  paused: boolean;
  memory: TutorialMemory;
}

interface TutorialContextValue {
  /** The section running in this tab, or null. */
  running: { section: TutorialSectionId; step: number; paused: boolean } | null;
  /** Starts the sections in order, the first at `step` (to resume it); replaces any run. */
  start: (sections: readonly TutorialSectionId[], step?: number) => void;
  /** Each section's place as this tab last saved it, ahead of what the server last said. */
  saved: Partial<Record<TutorialSectionId, SectionProgress>>;
}

const TutorialContext = createContext<TutorialContextValue>({
  running: null,
  start: () => {},
  saved: {},
});

export const useTutorial = () => useContext(TutorialContext);

/** The run lives in this tab, so a reload keeps the place and another tab or person is not led. */
const STORAGE = 'taskmoor.tutorial.run';

function loadRun(): Run | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE);
    if (!raw) return null;
    const run = JSON.parse(raw) as Partial<Run>;
    const queue = Array.isArray(run.queue)
      ? run.queue.filter(
          (id): id is TutorialSectionId => typeof id === 'string' && !!sectionById(id),
        )
      : [];
    if (queue.length === 0 || typeof run.user !== 'number') return null;
    return {
      user: run.user,
      queue,
      step: typeof run.step === 'number' && run.step >= 0 ? Math.floor(run.step) : 0,
      paused: run.paused === true,
      memory: typeof run.memory === 'object' && run.memory !== null ? run.memory : {},
    };
  } catch {
    return null;
  }
}

function storeRun(run: Run | null) {
  try {
    if (run) window.sessionStorage.setItem(STORAGE, JSON.stringify(run));
    else window.sessionStorage.removeItem(STORAGE);
  } catch {
    // A browser that keeps nothing still runs the tutorial; a reload starts over from Settings.
  }
}

/** Where focus is a field, a menu or another dialog's: the card waits there rather than take it. */
function busyElsewhere(card: Element | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return !card?.contains(active);
}

/** What keeps Escape for itself: a field, a menu or list and what opens one, another dialog. */
const OWN_ESCAPE = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-expanded="true"]',
].join(', ');

/**
 * Whether Escape is the focused element's own: it pauses the tutorial everywhere else, a link
 * or a button on the page included, as the card says.
 */
function escapeTakenBy(active: Element | null, card: Element | null): boolean {
  if (!active || active === document.body || card?.contains(active)) return false;
  return active.closest(OWN_ESCAPE) !== null;
}

function satisfied(done: StepDone): boolean {
  if ('route' in done) {
    return [currentRoute(), overlayRoute()].some((r) => r !== null && done.route.test(r));
  }
  if ('appears' in done) {
    return document.querySelector(`[data-tutorial="${done.appears}"]`) !== null;
  }
  return false;
}

export interface TutorialProviderProps {
  client?: TutorialClient;
  children: ReactNode;
}

/**
 * The guided tutorial's runner (ADR-115): which section and step this tab is on, saved with the
 * person's account as it moves, and the steps that move on by themselves once the person has done
 * what they ask. `TutorialCoach` draws it.
 */
export function TutorialProvider({ client = tutorialClient, children }: TutorialProviderProps) {
  const { session } = useSession();
  const signedIn = session.status === 'signed-in';
  const user = signedIn ? session.user : null;
  const userId = user?.id ?? null;
  const siteAdmin = user?.isSiteAdmin ?? false;
  const configAdmin = user?.isConfigAdmin;
  const localTracks = user?.mayCreateLocalTracks;
  const audience = useMemo<TutorialAudience>(
    () =>
      audienceOf(
        signedIn
          ? {
              isSiteAdmin: siteAdmin,
              isConfigAdmin: configAdmin,
              mayCreateLocalTracks: localTracks,
            }
          : null,
      ),
    [signedIn, siteAdmin, configAdmin, localTracks],
  );
  const [run, setRun] = useState<Run | null>(loadRun);
  const [saved, setSaved] = useState<Partial<Record<TutorialSectionId, SectionProgress>>>({});
  // Entered with Back: the person wants to read it again, so it does not move on by itself.
  const [manual, setManual] = useState(false);
  // Bumped whenever the card should take focus; a step reached while the person works elsewhere
  // is only announced, through the card's status line.
  const [focusKey, setFocusKey] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => storeRun(run), [run]);

  const save = useCallback(
    (section: TutorialSectionId, state: SectionProgress['state'], step: number) => {
      setSaved((s) => ({ ...s, [section]: { section, state, step } }));
      // Progress is a convenience: a failed save leaves the run going and the server's last word.
      client.save(section, state, step).catch(() => {});
    },
    [client],
  );

  const giveFocusBack = useCallback(() => {
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus();
    else document.getElementById('main')?.focus();
  }, []);

  const start = useCallback(
    (sections: readonly TutorialSectionId[], step = 0) => {
      const queue = sections.filter((id) => {
        const section = sectionById(id);
        return section !== undefined && mayTake(section, audience);
      });
      const first = queue[0];
      if (!first || userId === null) return;
      const count = stepsFor(first, audience).length;
      const at = Math.min(Math.max(0, step), count - 1);
      const active = document.activeElement;
      if (!card.current?.contains(active)) {
        returnFocus.current = active instanceof HTMLElement ? active : null;
      }
      setRun({
        user: userId,
        queue,
        step: at,
        paused: false,
        memory: remember({}, [currentRoute()]),
      });
      setManual(false);
      setFocusKey((k) => k + 1);
      save(first, 'active', at);
    },
    [audience, userId, save],
  );

  // Signed out: the run ends here; progress stays on the server.
  useEffect(() => {
    if (session.status === 'anonymous') setRun(null);
  }, [session.status]);

  const current = run && userId !== null && run.user === userId ? run.queue[0] : undefined;
  const steps = useMemo(() => (current ? stepsFor(current, audience) : []), [current, audience]);
  const index = run ? Math.min(run.step, Math.max(0, steps.length - 1)) : 0;
  const step = steps[index];

  /** Ends the section showing as done or skipped, then starts the next one queued, if any. */
  const endSection = useCallback(
    (state: 'done' | 'skipped') => {
      if (!run || !current) return;
      save(current, state, index);
      const rest = run.queue.slice(1);
      setManual(false);
      if (rest[0]) {
        // From the run as it now stands: a route noted in the same moment stays remembered.
        setRun((r) => (r ? { ...r, queue: r.queue.slice(1), step: 0, paused: false } : r));
        save(rest[0], 'active', 0);
        setFocusKey((k) => k + 1);
      } else {
        setRun(null);
        giveFocusBack();
      }
    },
    [run, current, index, save, giveFocusBack],
  );

  const goTo = useCallback(
    (next: number, how: 'button' | 'back' | 'auto') => {
      if (!run || !current) return;
      // From the run as it now stands, not as last drawn: the route that finished the step may
      // also have told the run what the person opened, in the same moment.
      setRun((r) => (r ? { ...r, step: next, paused: false } : r));
      setManual(how === 'back');
      save(current, 'active', next);
      if (how !== 'auto' || !busyElsewhere(card.current)) setFocusKey((k) => k + 1);
    },
    [run, current, save],
  );

  const next = useCallback(
    (how: 'button' | 'auto') => {
      if (index >= steps.length - 1) endSection('done');
      else goTo(index + 1, how);
    },
    [index, steps.length, endSection, goTo],
  );

  const pause = useCallback(() => {
    if (!run) return;
    setRun((r) => (r ? { ...r, paused: true } : r));
    giveFocusBack();
  }, [run, giveFocusBack]);

  const resume = useCallback(() => {
    if (!run) return;
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    setRun((r) => (r ? { ...r, paused: false } : r));
    setFocusKey((k) => k + 1);
  }, [run]);

  // Stops for now: the section stays in progress at this step, to resume from Settings.
  const close = useCallback(() => {
    setRun(null);
    giveFocusBack();
  }, [giveFocusBack]);

  // What the person opens along the way: the way back to what they made.
  useEffect(() => {
    if (!current) return;
    const note = () =>
      setRun((r) => {
        if (!r) return r;
        const memory = remember(r.memory, [currentRoute(), overlayRoute()]);
        return memory === r.memory ? r : { ...r, memory };
      });
    note();
    return onRouteChange(note);
  }, [current]);

  // A step that asks for something moves on once it is done: here, or with the server's word.
  const advance = useRef(next);
  advance.current = next;
  const paused = run?.paused ?? true;
  useEffect(() => {
    const done = step?.done;
    if (!current || paused || manual || !done || done.length === 0) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      advance.current('auto');
    };
    const check = () => {
      if (done.some(satisfied)) finish();
    };
    check();
    const offRoute = onRouteChange(check);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    const offApi = onApiChange((change) => {
      if (
        done.some(
          (d) =>
            'request' in d &&
            d.request.method.test(change.method) &&
            d.request.path.test(change.path),
        )
      ) {
        finish();
      }
    });
    return () => {
      finished = true;
      offRoute();
      observer.disconnect();
      offApi();
    };
  }, [current, step, paused, manual]);

  // Escape with nothing else to close pauses, as it does inside the card.
  useEffect(() => {
    if (!current || paused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A modal dialog over the page takes its own Escape first.
      if (document.querySelector('[aria-modal="true"]')) return;
      if (escapeTakenBy(document.activeElement, card.current)) return;
      event.preventDefault();
      pause();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [current, paused, pause]);

  const value = useMemo<TutorialContextValue>(
    () => ({
      running: current && run ? { section: current, step: index, paused: run.paused } : null,
      start,
      saved,
    }),
    [current, run, index, start, saved],
  );

  const coach =
    current && run && step
      ? {
          section: current,
          step,
          index,
          count: steps.length,
          paused: run.paused,
          manual,
          memory: run.memory,
          focusKey,
          card,
          onBack: () => goTo(Math.max(0, index - 1), 'back'),
          onNext: () => next('button'),
          onPause: pause,
          onResume: resume,
          onSkip: () => endSection('skipped'),
          onClose: close,
        }
      : null;

  return (
    <TutorialContext.Provider value={value}>
      <CoachContext.Provider value={coach}>{children}</CoachContext.Provider>
    </TutorialContext.Provider>
  );
}

type CoachState = {
  section: TutorialSectionId;
  step: ReturnType<typeof stepsFor>[number];
  index: number;
  count: number;
  paused: boolean;
  /** Entered with Back: it waits for Next, whatever the person does on the page. */
  manual: boolean;
  memory: TutorialMemory;
  focusKey: number;
  card: MutableRefObject<HTMLDivElement | null>;
  onBack: () => void;
  onNext: () => void;
  onPause: () => void;
  onResume: () => void;
  onSkip: () => void;
  onClose: () => void;
} | null;

const CoachContext = createContext<CoachState>(null);

/**
 * The coach card, the ring around the control to use and, while paused, the way back in. Placed
 * in the page's main area, so it is part of the page's landmarks; it floats over the page.
 */
export function TutorialCoach() {
  const t = useT();
  const coach = useContext(CoachContext);
  // Read again on every change of page: the way back to the step's page shows only when away.
  const route = useRoute();
  const overlay = useOverlayRoute();
  // What is docked at the bottom of a phone, the card or the paused panel: the page and any
  // dialog over it keep room of its height (`--coach-space`) to scroll what it covers above it.
  const docked = coach === null ? null : coach.paused ? 'paused' : 'open';
  useEffect(() => {
    if (!docked) return;
    document.documentElement.dataset.coach = docked;
    return () => {
      delete document.documentElement.dataset.coach;
      document.documentElement.style.removeProperty('--coach-space');
    };
  }, [docked]);
  if (!coach) return null;
  const section = sectionById(coach.section);
  if (!section) return null;
  const sectionTitle = t(section.titleId);
  if (coach.paused) {
    return (
      <PausedCoach
        sectionTitle={sectionTitle}
        index={coach.index}
        count={coach.count}
        onResume={coach.onResume}
        onClose={coach.onClose}
      />
    );
  }
  const { step, memory } = coach;
  const routes = [route, overlay];
  const away = step.page && !routes.some((r) => r !== null && step.page?.match.test(r));
  const goThere = away ? (step.page?.href(memory) ?? null) : null;
  const made = step.made ? step.made(memory) || null : null;
  return (
    <>
      <Spotlight key={`${coach.section}-${step.id}`} target={step.target} card={coach.card} />
      <CoachCard
        cardRef={coach.card}
        sectionTitle={sectionTitle}
        title={t(stepTitleId(coach.section, step))}
        body={t(stepBodyId(coach.section, step))}
        index={coach.index}
        count={coach.count}
        waiting={Boolean(step.done?.length) && !coach.manual}
        goThere={goThere}
        made={made}
        focusKey={coach.focusKey}
        onBack={coach.onBack}
        onNext={coach.onNext}
        onPause={coach.onPause}
        onSkip={coach.onSkip}
      />
    </>
  );
}

export type { TutorialAudience };

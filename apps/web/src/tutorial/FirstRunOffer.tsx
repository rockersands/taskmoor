import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { TourIcon } from '../shell/icons';
import { type TutorialClient, tutorialClient } from './client';
import { audienceOf, SUGGESTED, sectionsFor, type TutorialSectionId } from './sections';
import { TutorialPicker } from './TutorialPicker';
import { useTutorial } from './TutorialProvider';

export interface FirstRunOfferProps {
  /** Stories and tests pass their own backend; the offer calls the API otherwise. */
  client?: TutorialClient;
}

type Shown =
  | { status: 'waiting' }
  | { status: 'offering' }
  | { status: 'answered'; note: 'later' | 'never' | null }
  /** Seen on an earlier visit, or answered: a small "Getting started" link instead (D10). */
  | { status: 'collapsed' }
  | { status: 'hidden' };

/**
 * The tutorial's first-run offer (ADR-115), at the top of Home the first time someone sees it: the
 * sections as cards to tick, the suggested ones ticked, then Start, Not now or Don't offer again.
 * Being shown counts as seen, and is saved with the account at once (PL-9, D10): from the next
 * visit on, and after any answer, it is a small "Getting started" link to Settings, Tutorials, so
 * the person's own work comes first. It sits in the page rather than over it.
 */
export function FirstRunOffer({ client = tutorialClient }: FirstRunOfferProps) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  const { start } = useTutorial();
  const user = session.status === 'signed-in' ? session.user : null;
  const sections = sectionsFor(audienceOf(user));
  const [shown, setShown] = useState<Shown>({ status: 'waiting' });
  const [selected, setSelected] = useState<TutorialSectionId[]>(() =>
    sections.filter((s) => SUGGESTED.includes(s.id)).map((s) => s.id),
  );
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const note = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let live = true;
    client.progress().then(
      (progress) => {
        if (!live) return;
        // Offered in full once, to someone who has not started a section anyway; seen, it is
        // saved as shown, quietly (a failure only means it is offered once more).
        const fresh = progress.offer === null && progress.sections.length === 0;
        setShown(fresh ? { status: 'offering' } : { status: 'collapsed' });
        if (fresh) client.answerOffer('shown').catch(() => {});
      },
      () => live && setShown({ status: 'hidden' }),
    );
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (shown.status === 'answered' && shown.note) note.current?.focus();
  }, [shown]);

  if (!user || shown.status === 'waiting' || shown.status === 'hidden') return null;
  if (shown.status === 'collapsed') {
    return (
      <p className="tutorial-getting-started">
        <a href={routeHref('#/settings/tutorials')}>
          <TourIcon aria-hidden="true" />
          {t('tutorial.gettingStarted')}
        </a>
      </p>
    );
  }
  if (shown.status === 'answered') {
    if (!shown.note) return null;
    return (
      <p ref={note} className="tutorial-offer-note page-note" role="status" tabIndex={-1}>
        {t(shown.note === 'later' ? 'tutorial.offer.later' : 'tutorial.offer.neverNote')}{' '}
        <a href={routeHref('#/settings/tutorials')}>{t('tutorial.offer.open')}</a>
      </p>
    );
  }

  const chosen = sections.filter((s) => selected.includes(s.id)).map((s) => s.id);
  const answer = (state: 'shown' | 'dismissed', then: () => void) => {
    setBusy(true);
    setFailed(false);
    client.answerOffer(state).then(
      () => then(),
      () => {
        setBusy(false);
        setFailed(true);
      },
    );
  };

  return (
    <section className="tutorial-offer glass-card motion-settle" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="tutorial-offer-title">
        {t('tutorial.offer.title', { name: user.name })}
      </h2>
      <p className="tutorial-offer-body">{t('tutorial.offer.body')}</p>
      <TutorialPicker
        nested
        sections={sections}
        status={{}}
        selected={chosen}
        onSelect={setSelected}
      />
      {failed && (
        <p className="form-error" role="alert">
          {t('tutorial.offer.failed')}
        </p>
      )}
      <div className="form-actions tutorial-offer-actions">
        <button
          type="button"
          className="button-primary"
          disabled={busy || chosen.length === 0}
          onClick={() =>
            answer('shown', () => {
              setShown({ status: 'answered', note: null });
              start(chosen);
            })
          }
        >
          {t('tutorial.startSelected', { count: chosen.length })}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => answer('shown', () => setShown({ status: 'answered', note: 'later' }))}
        >
          {t('tutorial.offer.notNow')}
        </button>
        <button
          type="button"
          className="button-quiet"
          disabled={busy}
          onClick={() => answer('dismissed', () => setShown({ status: 'answered', note: 'never' }))}
        >
          {t('tutorial.offer.never')}
        </button>
      </div>
    </section>
  );
}

import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';
import { type SectionProgress, type TutorialClient, tutorialClient } from './client';
import { audienceOf, sectionsFor, type TutorialSectionId, type TutorialStatus } from './sections';
import { TutorialPicker } from './TutorialPicker';
import { useTutorial } from './TutorialProvider';

export interface TutorialsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: TutorialClient;
}

const STATUS: Record<SectionProgress['state'], TutorialStatus> = {
  active: 'active',
  done: 'done',
  skipped: 'skipped',
};

/**
 * Settings, Tutorials (ADR-115): every section the person may take, with where they are in it, to
 * start, resume or do again at any time, also after skipping the first-run offer. Ticked sections
 * start one after another.
 */
export function TutorialsPage({ client = tutorialClient }: TutorialsPageProps) {
  const t = useT();
  const titleId = useId();
  const { session } = useSession();
  const { start, saved, running } = useTutorial();
  const user = session.status === 'signed-in' ? session.user : null;
  const sections = sectionsFor(audienceOf(user));
  const [stored, setStored] = useState<SectionProgress[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<TutorialSectionId[] | null>(null);

  useEffect(() => {
    let live = true;
    client.progress().then(
      (progress) => live && setStored(progress.sections),
      () => {
        if (!live) return;
        setStored([]);
        setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  // What this tab saved since the page read the server wins: it is newer.
  const places = useMemo(() => {
    const byId: Partial<Record<TutorialSectionId, SectionProgress>> = {};
    for (const row of stored ?? []) byId[row.section] = row;
    return { ...byId, ...saved };
  }, [stored, saved]);
  const status: Partial<Record<TutorialSectionId, TutorialStatus>> = {};
  for (const [id, place] of Object.entries(places)) {
    if (place) status[id as TutorialSectionId] = STATUS[place.state];
  }

  // Ticked at first: every section not done yet, once the progress is known.
  const ticked =
    selected ?? (stored ? sections.filter((s) => status[s.id] !== 'done').map((s) => s.id) : []);
  const chosen = sections.filter((s) => ticked.includes(s.id)).map((s) => s.id);

  const startOne = (id: TutorialSectionId) => {
    const place = places[id];
    // Resume where the person left off; anything else starts at the beginning.
    start([id], place?.state === 'active' ? place.step : 0);
  };

  return (
    <section aria-labelledby={titleId} className="tutorials-page">
      <PageHeader
        titleId={titleId}
        title={t('tutorial.title')}
        purpose={t('tutorial.purpose')}
        about={t('tutorial.about')}
        actions={
          <button
            type="button"
            className="button-primary"
            disabled={chosen.length === 0}
            onClick={() => start(chosen)}
          >
            {t('tutorial.startSelected', { count: chosen.length })}
          </button>
        }
      />
      {failed && (
        <p className="form-error" role="alert">
          {t('tutorial.loadFailed')}
        </p>
      )}
      {running && (
        <p className="page-note" role="status">
          {t('tutorial.runningNote')}
        </p>
      )}
      {stored === null ? (
        <p className="page-note">{t('tutorial.loading')}</p>
      ) : (
        <TutorialPicker
          sections={sections}
          status={status}
          selected={chosen}
          onSelect={setSelected}
          onStart={startOne}
        />
      )}
    </section>
  );
}

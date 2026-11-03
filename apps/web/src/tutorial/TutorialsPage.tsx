import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';
import { TUTORIAL_SECTIONS, type TutorialSectionId } from './sections';
import { TutorialPicker } from './TutorialPicker';

/**
 * Settings, Tutorials (ADR-115): every section of the guided tutorial, to start, resume or do
 * again at any time, also after skipping the first-run offer.
 */
export function TutorialsPage() {
  const t = useT();
  const titleId = useId();
  const { session } = useSession();
  const admin = session.status === 'signed-in' && session.user.isSiteAdmin;
  const [selected, setSelected] = useState<TutorialSectionId[]>(() =>
    TUTORIAL_SECTIONS.filter((s) => !s.admin).map((s) => s.id),
  );
  return (
    <section aria-labelledby={titleId} className="tutorials-page">
      <PageHeader
        titleId={titleId}
        title={t('tutorial.title')}
        purpose={t('tutorial.purpose')}
        about={t('tutorial.about')}
        actions={
          <button type="button" className="button-primary" disabled={selected.length === 0}>
            {t('tutorial.startSelected', { count: selected.length })}
          </button>
        }
      />
      <TutorialPicker
        admin={admin}
        status={{}}
        selected={selected}
        onSelect={setSelected}
        onStart={() => {}}
      />
    </section>
  );
}

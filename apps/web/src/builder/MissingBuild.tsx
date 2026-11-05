import { useT } from '../i18n/I18nProvider';
import { PageHeader } from '../shell/PageHeader';

/** The Builder page without a web build inside, as in development before `pnpm build`. */
export function MissingBuild() {
  const t = useT();
  return (
    <main className="builder">
      <PageHeader title={t('builder.title')} purpose={t('builder.intro')} />
      <p className="form-error" role="alert">
        {t('builder.noBuild')}
      </p>
    </main>
  );
}

import { useT } from '../i18n/I18nProvider';

/** The Builder page without a web build inside, as in development before `pnpm build`. */
export function MissingBuild() {
  const t = useT();
  return (
    <main className="builder">
      <h1 className="page-title">{t('builder.title')}</h1>
      <p className="form-error" role="alert">
        {t('builder.noBuild')}
      </p>
    </main>
  );
}

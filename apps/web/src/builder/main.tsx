import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { resolveLocale } from '../i18n/locale';
import { BuilderPage } from './BuilderPage';
import { carriedBuild } from './embedded';
import { MissingBuild } from './MissingBuild';
import '../styles/tokens.css';
import '../styles/shell.css';
import '../styles/forms.css';
import '../styles/admin.css';
import './builder.css';

// The Builder page (M1-112, ADR-088): one static file with the web build inside. The skin
// follows the system's, as the app's boot script does for a person with no saved choice.
const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
document.documentElement.dataset.skin = dark ? 'dark' : 'light';

const build = carriedBuild();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nProvider locale={resolveLocale()}>
        {build ? <BuilderPage web={build.web} version={build.version} /> : <MissingBuild />}
      </I18nProvider>
    </StrictMode>,
  );
}

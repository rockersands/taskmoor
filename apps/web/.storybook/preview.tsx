import type { Preview } from '@storybook/react-vite';
import { I18nProvider } from '../src/i18n/I18nProvider';
import '../src/styles/tokens.css';
import '../src/styles/shell.css';
import '../src/styles/forms.css';
import '../src/styles/admin.css';
import '../src/styles/account.css';
import '../src/styles/api-tokens.css';
import '../src/styles/twofactor.css';
import '../src/styles/sso.css';
import '../src/styles/directories.css';
import '../src/styles/tickets.css';
import '../src/styles/trash.css';
import '../src/styles/attachments.css';
import '../src/styles/bulk.css';
import '../src/styles/comments.css';
import '../src/styles/ticket-view.css';
import '../src/styles/ticket-tools.css';
import '../src/styles/people.css';
import '../src/styles/inbox.css';
import '../src/styles/boards.css';
import '../src/styles/ticket-icons.css';
import '../src/styles/workflows.css';
import '../src/styles/richtext.css';
import '../src/styles/search.css';
import '../src/styles/charts.css';
import '../src/styles/dashboards.css';
import '../src/styles/releases.css';
import '../src/styles/ticket-templates.css';
import '../src/styles/timeline.css';
import '../src/styles/views.css';
import '../src/styles/plans.css';
import '../src/styles/ai.css';
import '../src/styles/surfaces.css';
import '../src/styles/track-groups.css';
import '../src/styles/layout-editor.css';
import '../src/styles/motion.css';
import '../src/builder/builder.css';

const preview: Preview = {
  parameters: {
    // Every story is an accessibility test: a serious or critical axe violation fails it.
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  // The skin a story renders in (ADR-036); the tests run every story in each skin.
  globalTypes: {
    skin: {
      description: 'Skin',
      toolbar: { title: 'Skin', icon: 'paintbrush', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { skin: 'light' },
  decorators: [
    (Story, context) => {
      // Story tests set the skin per run (vitest.setup.ts); the toolbar decides otherwise.
      const tested = (globalThis as { taskmoorStorySkin?: string }).taskmoorStorySkin;
      document.documentElement.dataset.skin = tested ?? String(context.globals.skin ?? 'light');
      return (
        <I18nProvider locale="en">
          <Story />
        </I18nProvider>
      );
    },
  ],
};

export default preview;

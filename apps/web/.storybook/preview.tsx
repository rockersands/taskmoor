import type { Preview } from '@storybook/react-vite';
import { I18nProvider } from '../src/i18n/I18nProvider';
import '../src/styles/tokens.css';
import '../src/styles/shell.css';
import '../src/styles/forms.css';
import '../src/styles/admin.css';
import '../src/styles/account.css';

const preview: Preview = {
  parameters: {
    // Every story is an accessibility test: a serious or critical axe violation fails it.
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <I18nProvider locale="en">
        <Story />
      </I18nProvider>
    ),
  ],
};

export default preview;

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { router } from './routing/router';
import { oauthClient } from './session/oauth';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/forms.css';
import './styles/standalone.css';
import './styles/shared.css';
import './styles/admin.css';
import './styles/account.css';
import './styles/api-tokens.css';
import './styles/twofactor.css';
import './styles/sso.css';
import './styles/directories.css';
import './styles/tickets.css';
import './styles/trash.css';
import './styles/attachments.css';
import './styles/bulk.css';
import './styles/comments.css';
import './styles/ticket-view.css';
import './styles/ticket-tools.css';
import './styles/people.css';
import './styles/invitations.css';
import './styles/inbox.css';
import './styles/boards.css';
import './styles/ticket-icons.css';
import './styles/workflows.css';
import './styles/richtext.css';
import './styles/search.css';
import './styles/charts.css';
import './styles/dashboards.css';
import './styles/releases.css';
import './styles/ticket-templates.css';
import './styles/timeline.css';
import './styles/views.css';
import './styles/plans.css';
import './styles/grid.css';
import './styles/ai.css';
import './styles/surfaces.css';
import './styles/track-groups.css';
import './styles/drag.css';
import './styles/layout-editor.css';
import './styles/fields.css';
import './styles/motion.css';
import './styles/print.css';

async function start() {
  // Back from a backend on another site with a sign-in code (M1-107): trade it and restore the
  // address the person was at, before the router reads the address.
  if (oauthClient) await oauthClient.complete();
  // Clean URLs (M1-105): a hash link becomes its path and links stay in the page.
  router.start();

  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element in index.html');

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();

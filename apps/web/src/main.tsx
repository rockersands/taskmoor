import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/forms.css';
import './styles/admin.css';
import './styles/account.css';
import './styles/api-tokens.css';
import './styles/twofactor.css';
import './styles/sso.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element in index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

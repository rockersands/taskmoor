import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { User } from './client';

export interface EraseUserFormProps {
  user: User;
  /** Erases the person with the email as typed; rejects as the API does. */
  onErase: (confirmEmail: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Erasing a person (ASVS 8.3.2, IAM-008 (2); ADR-111), for site administrators: what it does,
 * and a confirmation by typing the person's email. The button works only once the email
 * matches; the server checks it again.
 */
export function EraseUserForm({ user, onErase, onCancel }: EraseUserFormProps) {
  const t = useT();
  const id = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();
  return (
    <form
      className="people-form"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!matches) return;
        setBusy(true);
        void onErase(typed.trim()).finally(() => setBusy(false));
      }}
    >
      <h2 id={`${id}-title`} className="facts-title">
        {t('admin.users.eraseTitle', { name: user.name })}
      </h2>
      <p className="page-note">{t('admin.users.eraseIntro')}</p>
      <div className="form-field">
        <label htmlFor={`${id}-email`} className="form-label">
          {t('admin.users.eraseConfirm', { email: user.email })}
        </label>
        <input
          id={`${id}-email`}
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-danger" disabled={!matches || busy}>
          {t('admin.users.eraseNow')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.users.eraseCancel')}
        </button>
      </div>
    </form>
  );
}

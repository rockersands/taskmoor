import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';

export interface GroupNameDialogProps {
  /** A new group, or the name a group has now. */
  mode: 'new' | 'rename';
  initial?: string;
  onClose: () => void;
  onSave: (name: string) => void;
}

/** Naming a group as it is made from tracks dragged together, or renaming one (CORE-034). */
export function GroupNameDialog({ mode, initial = '', onClose, onSave }: GroupNameDialogProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('trackGroups.closeDialog')}
      focusFirstField
    >
      <h2 id={`${id}-title`} className="section-title">
        {t(mode === 'new' ? 'trackGroups.new.title' : 'trackGroups.rename.title')}
      </h2>
      {mode === 'new' && <p className="page-note">{t('trackGroups.new.intro')}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onSave(trimmed);
        }}
      >
        <div className="form-field">
          <label htmlFor={`${id}-name`} className="form-label">
            {t('trackGroups.name')}
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={!trimmed}>
            {t(mode === 'new' ? 'trackGroups.create' : 'trackGroups.save')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('trackGroups.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

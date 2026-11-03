import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';

export interface CreateTracksBoxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The box that gives the permission to create tracks along with the role that runs a track
 * (IAM-033): ticked unless the person unticks it. Shown only to someone who may give it, a site
 * administrator or a person who holds it; the server decides either way.
 */
export function CreateTracksBox({ checked, onChange }: CreateTracksBoxProps) {
  const t = useT();
  const id = useId();
  return (
    <>
      <div className="form-field form-field-inline">
        <input
          id={`${id}-box`}
          type="checkbox"
          checked={checked}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.checked)}
        />
        <label htmlFor={`${id}-box`}>{t('trackPeople.createTracks')}</label>
      </div>
      <p id={`${id}-hint`} className="form-hint">
        {t('trackPeople.createTracksHint')}
      </p>
    </>
  );
}

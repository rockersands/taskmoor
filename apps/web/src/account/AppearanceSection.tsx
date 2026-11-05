import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { type SessionUser, useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  type Appearance,
  applyAppearance,
  SKINS,
  storedAppearance,
  toAppearance,
} from '../skins/skins';
import type { AccountClient } from './client';

export interface AppearanceSectionProps {
  user: SessionUser;
  client: AccountClient;
}

/**
 * How Taskmoor looks for this person (M1-122, ADR-036): System, or one of the skins. A choice
 * applies at once and is saved with the account, so it follows the person to other devices.
 */
export function AppearanceSection({ user, client }: AppearanceSectionProps) {
  const t = useT();
  const { setUser } = useSession();
  const expired = useSessionExpiry();
  const id = useId();
  const [choice, setChoice] = useState<Appearance>(() =>
    user.appearance === undefined ? storedAppearance() : toAppearance(user.appearance),
  );
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

  const choose = async (next: Appearance) => {
    setChoice(next);
    setStatus('idle');
    applyAppearance(next);
    try {
      setUser(await client.updateProfile({ appearance: next }));
      setStatus('saved');
    } catch (error) {
      if (expired(error)) return;
      setStatus('failed');
    }
  };

  const options: { value: Appearance; label: string; hint: string; preview: string }[] = [
    {
      value: 'system',
      label: t('account.appearance.system'),
      hint: t('account.appearance.systemHint'),
      preview: 'system',
    },
    ...SKINS.map((skin) => ({
      value: skin.id,
      label: t(skin.labelId),
      hint: t(skin.hintId),
      preview: skin.id,
    })),
  ];

  return (
    <section aria-labelledby={`${id}-title`} className="glass-card account-section">
      <h2 id={`${id}-title`} className="facts-title">
        {t('account.appearance')}
      </h2>
      <p className="page-note">{t('account.appearance.intro')}</p>
      <fieldset className="appearance-options">
        <legend className="visually-hidden">{t('account.appearance')}</legend>
        {options.map((option) => {
          const inputId = `${id}-${option.value}`;
          return (
            <label key={option.value} htmlFor={inputId} className="appearance-option">
              <input
                id={inputId}
                type="radio"
                name={`${id}-appearance`}
                value={option.value}
                checked={choice === option.value}
                aria-labelledby={`${inputId}-name`}
                aria-describedby={`${inputId}-hint`}
                onChange={() => void choose(option.value)}
              />
              <SkinPreview skin={option.preview} />
              <span className="appearance-text">
                <span id={`${inputId}-name`} className="appearance-name">
                  {option.label}
                </span>
                <span id={`${inputId}-hint`} className="appearance-hint">
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="form-status" role="status">
        {status === 'saved' ? t('account.appearance.saved') : ''}
      </p>
      {status === 'failed' && (
        <p className="form-error" role="alert">
          {t('account.appearance.saveFailed')}
        </p>
      )}
    </section>
  );
}

/**
 * A miniature of a skin: the canvas, a floating bar and a card, painted with that skin's own
 * tokens (a nested `data-skin`). System shows light and dark side by side. Decoration only.
 */
function SkinPreview({ skin }: { skin: string }) {
  if (skin === 'system') {
    return (
      <span className="skin-preview skin-preview-split" aria-hidden="true">
        <span data-skin="light" className="skin-preview-half">
          <SkinPreviewShapes />
        </span>
        <span data-skin="dark" className="skin-preview-half">
          <SkinPreviewShapes />
        </span>
      </span>
    );
  }
  return (
    <span data-skin={skin} className="skin-preview" aria-hidden="true">
      <SkinPreviewShapes />
    </span>
  );
}

function SkinPreviewShapes() {
  return (
    <span className="skin-preview-canvas">
      <span className="skin-preview-bar" />
      <span className="skin-preview-card">
        <span className="skin-preview-line" />
        <span className="skin-preview-pill" />
      </span>
    </span>
  );
}

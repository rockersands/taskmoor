import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { SkinId } from '../skins/skins';
import { MoonIcon, SunIcon } from './icons';

interface ThemeToggleProps {
  /** Applies and saves the other mode; the account keeps the choice (ADR-036). */
  onChoose: (skin: SkinId) => void;
}

const current = (): SkinId =>
  typeof document !== 'undefined' && document.documentElement.dataset.skin === 'dark'
    ? 'dark'
    : 'light';

/**
 * Light or dark in one press, at the top bar (ADR-114). Account, Appearance keeps the full
 * choice, System included; this button picks the mode opposite to the one on screen.
 */
export function ThemeToggle({ onChoose }: ThemeToggleProps) {
  const t = useT();
  const [skin, setSkin] = useState<SkinId>(current);

  // The skin also changes from the account page, the palette and the device setting.
  useEffect(() => {
    const observer = new MutationObserver(() => setSkin(current()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-skin'],
    });
    return () => observer.disconnect();
  }, []);

  const next: SkinId = skin === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? t('theme.toDark') : t('theme.toLight');
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        onChoose(next);
        setSkin(next);
      }}
    >
      {next === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

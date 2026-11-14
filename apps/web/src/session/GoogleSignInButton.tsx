import { useT } from '../i18n/I18nProvider';
import { GoogleMark } from './GoogleMark';

/**
 * The button for a Google provider (T-061, IAM-031): Google's own sign-in button, as its sign-in
 * branding guidelines describe it. The G at the left and "Sign in with Google" in the person's
 * language, whatever name the site gave the provider; light or dark with the skin (sso.css). Its
 * words are its accessible name.
 */
export function GoogleSignInButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="google-sign-in" onClick={onClick}>
      <GoogleMark className="google-sign-in-mark" />
      <span className="google-sign-in-label">{t('auth.sso.google')}</span>
    </button>
  );
}

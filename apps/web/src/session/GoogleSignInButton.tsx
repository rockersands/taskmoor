import { useT } from '../i18n/I18nProvider';
import { GoogleMark } from './GoogleMark';

export interface GoogleSignInButtonProps {
  /** Starts Google's sign-in when pressed. */
  onClick: () => void;
}

/** The class that gives a button Google's look (sso.css). */
export const GOOGLE_SIGN_IN_CLASS = 'google-sign-in';

/**
 * What Google's sign-in button holds (T-061, IAM-031): the G at the left and "Sign in with
 * Google" in the person's language. Shared so the sign-in form can give its own submit button
 * Google's look without swapping the element, which would lose focus.
 */
export function GoogleSignInContent() {
  const t = useT();
  return (
    <>
      <GoogleMark className="google-sign-in-mark" />
      <span className="google-sign-in-label">{t('auth.sso.google')}</span>
    </>
  );
}

/**
 * The button for a Google provider (T-061, IAM-031): Google's own sign-in button, as its sign-in
 * branding guidelines describe it. The G at the left and "Sign in with Google" in the person's
 * language, whatever name the site gave the provider; light or dark with the skin (sso.css). Its
 * words are its accessible name.
 */
export function GoogleSignInButton({ onClick }: GoogleSignInButtonProps) {
  return (
    <button type="button" className={GOOGLE_SIGN_IN_CLASS} onClick={onClick}>
      <GoogleSignInContent />
    </button>
  );
}

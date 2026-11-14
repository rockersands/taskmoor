import { useT } from '../i18n/I18nProvider';
import { GoogleMark } from './GoogleMark';

export interface GoogleSignInButtonProps {
  /** Starts Google's sign-in when pressed, as one button among others. */
  onClick?: () => void;
  /**
   * `submit` makes it the sign-in form's own button, where the address's domain signs in only
   * through Google: the form's submit starts the sign-in, so Enter in the email field leads there.
   */
  type?: 'button' | 'submit';
  disabled?: boolean;
}

/**
 * The button for a Google provider (T-061, IAM-031): Google's own sign-in button, as its sign-in
 * branding guidelines describe it. The G at the left and "Sign in with Google" in the person's
 * language, whatever name the site gave the provider; light or dark with the skin (sso.css). Its
 * words are its accessible name. Also the form's submit button where single sign-on through
 * Google is required, so that one way in has Google's look too.
 */
export function GoogleSignInButton({
  onClick,
  type = 'button',
  disabled,
}: GoogleSignInButtonProps) {
  const t = useT();
  return (
    <button type={type} className="google-sign-in" onClick={onClick} disabled={disabled}>
      <GoogleMark className="google-sign-in-mark" />
      <span className="google-sign-in-label">{t('auth.sso.google')}</span>
    </button>
  );
}

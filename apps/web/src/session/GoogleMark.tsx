import googleG from '../assets/google/google-g.svg';

/**
 * Google's G (T-061, T-262): the gradient G of Google's own Sign in with Google branding assets
 * (signin-assets.zip, files dated 2026-04-15), its elements copied unchanged and the view cropped
 * to the G (`assets/google/google-g.svg`, THIRD_PARTY_NOTICES). Every theme of that bundle draws
 * the same G.
 *
 * Shown as an image rather than inline: each copy is its own document, so the ids its mask,
 * blurs and clip path refer to cannot meet those of a second button on the page, and the build
 * puts it in the bundle as a data URL, which every content security policy of the app allows
 * (`img-src data:`) and which nothing fetches from Google. It is decoration: the button's words
 * name it.
 */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <img className={className} src={googleG} alt="" width={20} height={20} draggable={false} />
  );
}

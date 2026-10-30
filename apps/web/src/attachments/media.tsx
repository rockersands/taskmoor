import { type ImgHTMLAttributes, useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import { oauthClient } from '../session/oauth';

/**
 * An address an image, video or frame can load a backend file from. With a backend on another
 * site no cookie travels with those loads (M1-107), so the file is fetched with the access
 * token and shown from a blob; otherwise the backend's address is used as it is. Null while
 * the blob is on its way.
 */
export function useMediaUrl(url: string): string | null {
  const [blob, setBlob] = useState<string | null>(null);
  useEffect(() => {
    if (!oauthClient) return;
    let live = true;
    let made: string | null = null;
    apiFetch(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then((body) => {
        if (!body || !live) return;
        made = URL.createObjectURL(body);
        setBlob(made);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setBlob(null);
    };
  }, [url]);
  return oauthClient ? blob : url;
}

/** An `<img>` of a backend file, loaded the way `useMediaUrl` says. */
export function MediaImage({
  src,
  alt,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const url = useMediaUrl(src);
  return url ? <img {...rest} src={url} alt={alt} /> : <span {...{ className: rest.className }} />;
}

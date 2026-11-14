import { Fragment } from 'react';

/**
 * A path or an address cut into the pieces a line may end after: each piece ends with its run of
 * slashes, so `http://` stays whole and `.cache/demo/data` breaks only after a `/`.
 */
export function slashPieces(text: string): string[] {
  return text.split(/(?<=\/)(?!\/)/).filter((piece) => piece !== '');
}

/**
 * Text that wraps only after a `/` (and at its spaces), never inside a folder name or a port
 * (AD-35): a `<wbr>` after each run of slashes, and `slash-breaks` in admin.css lets a piece break
 * inside only when it is wider than the line on its own.
 */
export function BreakAtSlashes({ text }: { text: string }) {
  const pieces = slashPieces(text);
  return (
    <span className="slash-breaks">
      {pieces.map((piece, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed text, in order
        <Fragment key={index}>
          {piece}
          {index < pieces.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}

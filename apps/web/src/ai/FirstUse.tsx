import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AiNotice, type AiNoticeClient, aiNoticeClient } from './AiNotice';

/** Runs `onRead` once, when it is first shown: inside the notice, that is once it is read. */
function WhenShown({ onRead }: { onRead: () => void }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    onRead();
  }, [onRead]);
  return null;
}

/**
 * The first use of an AI feature (M1-079; IAM-022): `run(action)` does the action at once when
 * the person has read the AI notice, and otherwise shows the notice (`gate`) and does it when
 * they have. Nothing is sent to the provider before that.
 */
export function useFirstUse(client: AiNoticeClient = aiNoticeClient): {
  gate: ReactNode;
  run: (action: () => void) => void;
} {
  const [read, setRead] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const onRead = useCallback(() => {
    setRead(true);
    setWaiting(false);
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);
  const run = useCallback(
    (action: () => void) => {
      if (read) {
        action();
        return;
      }
      pending.current = action;
      setWaiting(true);
    },
    [read],
  );
  const gate = waiting ? (
    <AiNotice client={client}>
      <WhenShown onRead={onRead} />
    </AiNotice>
  ) : null;
  return { gate, run };
}

import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';

/**
 * What a section of the Priorities page says after an action, beside the list it acted on: what
 * happened, or why the server refused. Each section has its own lines, so on a phone the answer
 * shows where the button was pressed rather than at the top of a long page.
 */
export interface Feedback {
  message: string;
  problem: string | null;
  /** Says what happened and reads the page again; settles once it is read. */
  said: (text: string) => Promise<void>;
  /** Says why the server refused, in words; a session that ran out asks to sign in instead. */
  refused: (error: unknown) => void;
  /** Says a refusal the caller has already put in words. */
  refusedWith: (text: string) => void;
}

export function useFeedback(reload: () => Promise<void>): Feedback {
  const t = useT();
  const expired = useSessionExpiry();
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const said = useCallback(
    (text: string) => {
      setMessage(text);
      setProblem(null);
      return reload();
    },
    [reload],
  );
  const refusedWith = useCallback((text: string) => {
    setMessage('');
    setProblem(text);
  }, []);
  const refused = useCallback(
    (error: unknown) => {
      if (expired(error)) return;
      const body =
        error instanceof ApiError ? (error.body as { error?: string; limit?: number }) : null;
      const code = body?.error;
      if (error instanceof ApiError && error.status === 404) {
        // Someone else deleted it meanwhile: show the list as it is now.
        refusedWith(t('admin.priorities.problem.gone'));
        void reload();
        return;
      }
      refusedWith(
        code === 'name_taken'
          ? t('admin.priorities.problem.nameTaken')
          : code === 'default_set'
            ? t('admin.priorities.problem.defaultSet')
            : code === 'guardrail_exceeded'
              ? t('admin.priorities.problem.limit', { limit: body?.limit ?? 0 })
              : error instanceof ApiError && error.status === 403
                ? t('admin.priorities.problem.forbidden')
                : t('admin.priorities.problem.other'),
      );
    },
    [expired, refusedWith, reload, t],
  );
  return { message, problem, said, refused, refusedWith };
}

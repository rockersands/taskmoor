import { automaticCsvSeparator, type CsvSeparator } from '@taskmoor/webconfig';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSession } from '../session/SessionProvider';
import { accountClient } from './client';

/**
 * How the person's CSV files are written (T-263; IAM-008, NFR-006): `comma`, with numbers as
 * 1.5, or `semicolon`, with numbers as 1,5. Their choice on Profile wins; without one
 * (`null`, Automatic), the style follows the decimal mark of their account's "Language and
 * region", else of the browser's language, which is what a spreadsheet there expects. Every CSV
 * control reads it here: the search export, the audit log, a plan's List and the files a plan
 * builds on the page, and a baseline's comparison.
 */
export function csvSeparatorFor(
  choice: CsvSeparator | null | undefined,
  locale: string | null | undefined,
  browser: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language,
): CsvSeparator {
  return choice ?? automaticCsvSeparator(locale ?? browser);
}

interface CsvStyleValue {
  /** The person's saved choice: undefined until known, null for Automatic. */
  choice: CsvSeparator | null | undefined;
  /** Asks the server once per person; a page with a CSV control calls it. */
  load: () => void;
  /** Takes a choice the profile just saved, so the controls follow at once. */
  remember: (choice: CsvSeparator | null) => void;
}

const CsvStyleContext = createContext<CsvStyleValue | null>(null);

const readChoice = async () => (await accountClient.preferences()).csvSeparator ?? null;

/**
 * Holds the signed-in person's choice for the whole app, read from
 * `GET /api/v1/account/preferences` the first time a page shows a CSV control. Without this
 * provider (tests, stories) the controls use the automatic style.
 */
export function CsvStyleProvider({
  children,
  read = readChoice,
}: {
  children: ReactNode;
  read?: () => Promise<CsvSeparator | null>;
}) {
  const { session } = useSession();
  const userId = session.status === 'signed-in' ? session.user.id : null;
  const [known, setKnown] = useState<{ userId: number; choice: CsvSeparator | null } | null>(null);
  const asked = useRef<number | null>(null);
  const load = useCallback(() => {
    if (userId === null || asked.current === userId) return;
    asked.current = userId;
    read().then(
      (choice) => setKnown((now) => (now?.userId === userId ? now : { userId, choice })),
      () => {
        // Automatic until the next page with a CSV control asks again.
        if (asked.current === userId) asked.current = null;
      },
    );
  }, [userId, read]);
  const remember = useCallback(
    (choice: CsvSeparator | null) => {
      if (userId === null) return;
      asked.current = userId;
      setKnown({ userId, choice });
    },
    [userId],
  );
  const choice = known !== null && known.userId === userId ? known.choice : undefined;
  const value = useMemo(() => ({ choice, load, remember }), [choice, load, remember]);
  return <CsvStyleContext.Provider value={value}>{children}</CsvStyleContext.Provider>;
}

/** The style of the person's CSV files, for a control that offers one. */
export function useCsvSeparator(): CsvSeparator {
  const context = useContext(CsvStyleContext);
  const { session } = useSession();
  const locale = session.status === 'signed-in' ? session.user.locale : null;
  const load = context?.load;
  useEffect(() => {
    load?.();
  }, [load]);
  return csvSeparatorFor(context?.choice, locale);
}

/** Lets the profile pass a saved choice on; does nothing without the provider. */
export function useRememberCsvChoice(): (choice: CsvSeparator | null) => void {
  const context = useContext(CsvStyleContext);
  return context?.remember ?? noop;
}

const noop = () => {};

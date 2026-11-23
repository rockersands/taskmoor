import type { CsvSeparator } from '@taskmoor/webconfig';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import {
  CsvStyleProvider,
  csvSeparatorFor,
  useCsvSeparator,
  useRememberCsvChoice,
} from './csvStyle';

const withLocale = (locale: string | null): Session =>
  MEMBER.status === 'signed-in' ? { ...MEMBER, user: { ...MEMBER.user, locale } } : MEMBER;

/** A CSV control: shows the style, and a button standing in for the profile's save. */
function Control({ save }: { save?: CsvSeparator | null }) {
  const separator = useCsvSeparator();
  const remember = useRememberCsvChoice();
  return (
    <p>
      <span data-testid="style">{separator}</span>
      {save !== undefined && (
        <button type="button" onClick={() => remember(save)}>
          save
        </button>
      )}
    </p>
  );
}

describe('the style of the person’s CSV files (T-263)', () => {
  it('[NFR-006] [IAM-008] follows the decimal mark of the account’s region, else the browser’s; a choice wins', () => {
    expect(csvSeparatorFor(null, 'es-ES', 'en-US')).toBe('semicolon');
    expect(csvSeparatorFor(null, 'es-MX', 'en-US')).toBe('comma');
    expect(csvSeparatorFor(null, 'pt-BR', 'en-US')).toBe('semicolon');
    // No region on the account: the browser's language decides.
    expect(csvSeparatorFor(null, null, 'de-DE')).toBe('semicolon');
    expect(csvSeparatorFor(undefined, null, 'en-GB')).toBe('comma');
    // An English interface in Spain: the choice on Profile wins either way.
    expect(csvSeparatorFor('semicolon', 'en-US', 'en-US')).toBe('semicolon');
    expect(csvSeparatorFor('comma', 'es-ES', 'es-ES')).toBe('comma');
  });

  it('[NFR-006] [IAM-008] a control without the provider uses the automatic style of the account’s region', () => {
    render(
      <SessionProvider session={withLocale('es-ES')}>
        <Control />
      </SessionProvider>,
    );
    expect(screen.getByTestId('style')).toHaveTextContent('semicolon');
  });

  it('[NFR-006] [IAM-008] reads the saved choice once, however many controls a page has, and follows a new one at once', async () => {
    const read = vi.fn(async (): Promise<CsvSeparator | null> => 'comma');
    render(
      <SessionProvider session={withLocale('es-ES')}>
        <CsvStyleProvider read={read}>
          <Control save="semicolon" />
          <Control />
        </CsvStyleProvider>
      </SessionProvider>,
    );
    // Automatic until the choice is read, then the choice.
    await vi.waitFor(() =>
      expect(screen.getAllByTestId('style').map((s) => s.textContent)).toEqual(['comma', 'comma']),
    );
    expect(read).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole('button', { name: 'save' }).click());
    expect(screen.getAllByTestId('style').map((s) => s.textContent)).toEqual([
      'semicolon',
      'semicolon',
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('[NFR-006] keeps the automatic style when the choice cannot be read', async () => {
    const read = vi.fn(async (): Promise<CsvSeparator | null> => {
      throw new Error('offline');
    });
    render(
      <SessionProvider session={withLocale('es-MX')}>
        <CsvStyleProvider read={read}>
          <Control />
        </CsvStyleProvider>
      </SessionProvider>,
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.getByTestId('style')).toHaveTextContent('comma');
  });
});

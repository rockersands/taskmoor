import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, useT } from './I18nProvider';

function Title() {
  const t = useT();
  return <h1>{t('home.title')}</h1>;
}

describe('I18nProvider (M1-116)', () => {
  it('[NFR-006] sets the page language and turns the page right to left for a right-to-left locale', () => {
    const { rerender } = render(
      <I18nProvider locale="ar-XB">
        <Title />
      </I18nProvider>,
    );
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar-XB');
    expect(screen.getByRole('heading')).toHaveTextContent('‮Home‬');
    rerender(
      <I18nProvider locale="en">
        <Title />
      </I18nProvider>,
    );
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { NotFoundContext, NotFoundPage } from './NotFoundPage';

describe('the not-found page (D4)', () => {
  it('[NFR-005] says what was not found and offers Home and Search', () => {
    render(
      <I18nProvider locale="en">
        <NotFoundPage title="Track not found">This track does not exist.</NotFoundPage>
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Track not found' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('This track does not exist.');
    const ways = screen.getByRole('navigation', { name: 'Ways on' });
    expect(ways.querySelector('a[href="#/home"]')).toHaveTextContent('Go to Home');
    expect(ways.querySelector('a[href="#/search"]')).toHaveTextContent('Go to Search');
  });

  it('[NFR-005] has a sentence of its own for an unknown address', () => {
    render(
      <I18nProvider locale="en">
        <NotFoundPage title="Page not found" />
      </I18nProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing is at this address/);
  });

  it('[NFR-005] tells the frame, so the navigation marks no section', () => {
    window.location.hash = '#/tracks/NOPE';
    const told = vi.fn();
    render(
      <I18nProvider locale="en">
        <NotFoundContext.Provider value={told}>
          <NotFoundPage title="Track not found" />
        </NotFoundContext.Provider>
      </I18nProvider>,
    );
    expect(told).toHaveBeenCalledWith('#/tracks/NOPE');
  });
});

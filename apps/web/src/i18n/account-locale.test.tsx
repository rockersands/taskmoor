import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import type { Session } from '../session/SessionProvider';
import { stubBackend } from '../test/backend';
import { catalogueFor, STORAGE_KEY } from './locale';

const member = MEMBER as Extract<Session, { status: 'signed-in' }>;
const withLocale = (locale: string | null): Session => ({
  status: 'signed-in',
  user: { ...member.user, locale },
});

describe('the language saved on the account (IAM-008, NFR-006)', () => {
  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    window.location.hash = '';
  });

  it('[NFR-006] picks the catalogue by the saved tag’s language, English without one', () => {
    expect(catalogueFor('es-MX')).toBe('es');
    expect(catalogueFor('EN-gb')).toBe('en');
    expect(catalogueFor('pt-PT')).toBe('en');
    expect(catalogueFor(null)).toBeNull();
  });

  it('[NFR-006] shows the app in the saved language once signed in, and remembers it', async () => {
    stubBackend({});
    window.location.hash = '#/home';
    render(<App session={withLocale('es-MX')} />);
    expect(await screen.findAllByRole('link', { name: 'Inicio' })).not.toHaveLength(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('es');
  });

  it('[NFR-006] lets ?locale= win over the account', async () => {
    stubBackend({});
    window.location.hash = '#/home?locale=en';
    render(<App session={withLocale('es-MX')} />);
    expect(await screen.findAllByRole('link', { name: 'Home' })).not.toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Inicio' })).toHaveLength(0);
  });

  it('[NFR-006] [IAM-008] keeps showing the saved language on Profile while ?locale= wins', async () => {
    // The third sweep's account pictures: the demo saves Spanish for everyone, the sweep reads
    // each page in English through ?locale=en, and Profile showed Spanish. That is the saved
    // choice, as it should be: the address changes the page's language, never the account's,
    // and a save from Profile keeps what the person chose.
    stubBackend({});
    window.location.hash = '#/account?locale=en';
    render(<App session={withLocale('es')} />);
    const language = await screen.findByRole('combobox', { name: 'Language and region' });
    expect(language).toHaveValue('es');
    expect(screen.getByRole('option', { name: 'Spanish', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('[NFR-006] leaves the browser’s choice alone when nothing is saved', async () => {
    stubBackend({});
    window.location.hash = '#/home';
    render(<App session={withLocale(null)} />);
    expect(await screen.findAllByRole('link', { name: 'Home' })).not.toHaveLength(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

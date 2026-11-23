import { generateKeyPairSync, sign } from 'node:crypto';
import { type PinnedInstance, signedMetaText } from '@taskmoor/webconfig';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { Meta, MetaClient } from './client';
import { UpdateBanner, VersionGate } from './VersionGate';

const backend = (version: string, minimum: string | null, recommended: string | null) =>
  ({
    meta: async (): Promise<Meta> => ({
      version,
      frontend: { minimum, recommended },
      instance: { id: 'i-1', name: 'Acme', publicKey: '' },
    }),
  }) satisfies MetaClient;

function open(
  client: MetaClient,
  version: string,
  locale: Locale = 'en',
  pin: PinnedInstance | null = null,
) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <VersionGate client={client} version={version} pin={pin}>
        <main>
          <UpdateBanner />
          <h1>The app</h1>
        </main>
      </VersionGate>
    </I18nProvider>,
  );
  return { errors, container: view.container };
}

describe('frontend and backend versions (M1-106)', () => {
  it('[OPS-017] (2) a frontend one release behind keeps working and shows the update notice', async () => {
    open(backend('1.4.2', '1.3.0', '1.4.0'), '1.3.5');
    const notice = await screen.findByRole('region', { name: 'A newer version is available.' });
    expect(notice).toHaveTextContent('This app is version 1.3.5 and the server runs 1.4.2.');
    expect(screen.getByRole('heading', { name: 'The app' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region', { name: 'A newer version is available.' })).toBeNull();
  });

  it('[API-018] (2) a frontend older than the backend serves shows "update required" instead of the app', async () => {
    open(backend('1.4.2', '1.3.0', '1.4.0'), '1.2.9');
    expect(await screen.findByRole('heading', { level: 1, name: 'Update required' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'The app' })).toBeNull();
    expect(screen.getByRole('main')).toHaveTextContent(
      'This version of the app (1.2.9) no longer works with the server, which runs 1.4.2.',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
  });

  it('[API-018] (2) puts what to do on a card, as every stand-alone page, and asks a site administrator (S3-SP-5, S3-SP-6)', async () => {
    open(backend('1.4.2', '1.3.0', '1.4.0'), '1.2.9');
    const reload = await screen.findByRole('button', { name: 'Reload' });
    const card = reload.closest('.glass-card');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent(
      'If this page comes back after reloading, the app itself needs updating: ask a site administrator.',
    );
  });

  it('[API-018] says nothing when versions match, on a development backend, or when the backend cannot be asked', async () => {
    const failing: MetaClient = { meta: () => Promise.reject(new Error('offline')) };
    for (const [client, version] of [
      [backend('1.4.2', '1.3.0', '1.4.0'), '1.4.0'],
      [backend('0.0.0-dev', null, null), '0.0.0-dev'],
      [failing, '1.0.0'],
    ] as const) {
      const { container } = open(client, version);
      await screen.findByRole('heading', { name: 'The app' });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('region')).toBeNull();
      container.remove();
    }
  });

  it('[OPS-017] the notice fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open(backend('1.4.2', '1.3.0', '1.4.0'), '1.3.5');
    await screen.findByRole('region', { name: 'A newer version is available.' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[OPS-017] every text goes through the catalogue (en-XA)', async () => {
    const { container, errors } = open(backend('1.4.2', '1.3.0', '1.4.0'), '1.2.9', 'en-XA');
    await screen.findByRole('button');
    expect(untranslated(visibleTexts(container).filter((t) => !/\d/.test(t)))).toEqual([]);
    expect(errors).toEqual([]);
  });

  describe('a frontend kit pinned to its instance (M1-111)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const instance = (id: string, signer = privateKey): MetaClient => ({
      meta: async (nonce) => ({
        version: '1.4.2',
        frontend: { minimum: '1.3.0', recommended: '1.4.0' },
        instance: { id, name: 'Acme', publicKey: key },
        ...(nonce
          ? {
              signature: {
                nonce,
                value: sign(null, Buffer.from(signedMetaText(id, nonce)), signer).toString(
                  'base64url',
                ),
              },
            }
          : {}),
      }),
    });
    const pin = { id: 'instance-a', publicKey: key };

    it('[API-017] (2) runs on the instance it was built for', async () => {
      // One release behind: the notice shows only once the instance checked out.
      open(instance('instance-a'), '1.3.5', 'en', pin);
      expect(
        await screen.findByRole('region', { name: 'A newer version is available.' }),
      ).toBeVisible();
      expect(screen.getByRole('heading', { name: 'The app' })).toBeVisible();
    });

    it('[API-017] (2) refuses another instance before anyone signs in', async () => {
      open(instance('instance-b'), '1.4.0', 'en', pin);
      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'This app belongs to another server',
        }),
      ).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'The app' })).toBeNull();
      // On a card, and a site administrator to ask (S3-SP-5, S3-SP-6).
      expect(
        screen
          .getByText(/^Ask a site administrator for the app of this server/)
          .closest('.glass-card'),
      ).not.toBeNull();
    });

    it('[API-017] (2) refuses a backend that signs with another key under the pinned id', async () => {
      const other = generateKeyPairSync('ed25519').privateKey;
      open(instance('instance-a', other), '1.4.0', 'en', pin);
      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'This app belongs to another server',
        }),
      ).toBeVisible();
    });
  });
});

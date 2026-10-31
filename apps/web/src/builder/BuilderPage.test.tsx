import {
  generateSecrets,
  readZip,
  saveProject,
  seededRandom,
  systemRandom,
  toBase64url,
  utf8,
  validateInputs,
} from '@taskmoor/builder-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { BuilderPage } from './BuilderPage';
import { generateKits } from './generate';

const WEB = {
  'index.html': utf8(
    '<!doctype html><html><head><meta charset="UTF-8" /><script id="taskmoor-config" type="application/json">{}</script><script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>',
  ),
  'assets/app.js': utf8('console.log(1);'),
};
const SEED = 'a seed for the page test only';

// jsdom's Blob has no text() or arrayBuffer(), which every browser the page supports has.
const read = (blob: Blob) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
Blob.prototype.arrayBuffer ??= function (this: Blob) {
  return read(this);
} as Blob['arrayBuffer'];
Blob.prototype.text ??= async function (this: Blob) {
  return new TextDecoder().decode(await read(this));
};

/** Blobs the page handed out, by their URL. */
let blobs: Map<string, Blob>;
beforeEach(() => {
  blobs = new Map();
  let n = 0;
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:builder-test/${n++}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  return () => {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  };
});

function renderPage(locale: Locale = 'en') {
  const errors: Error[] = [];
  render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <BuilderPage web={WEB} version="1.4.2" />
    </I18nProvider>,
  );
  return errors;
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Backend address'), 'https://api.example.com');
  await user.type(screen.getByLabelText('Frontend address'), 'https://tracker.example.com/');
}

/** A download's bytes as hex, to compare across realms (jsdom's arrays are not Node's). */
const bytesOf = async (url: string | null) =>
  Buffer.from(await (blobs.get(url ?? '') as Blob).arrayBuffer()).toString('hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('the Builder page (M1-112)', () => {
  it('[OPS-014] (2) shows the core problems of each field, in the page language', async () => {
    const user = userEvent.setup();
    const errors = renderPage();
    await user.type(screen.getByLabelText('Backend address'), 'http://api.example.com');
    await user.type(screen.getByLabelText('Frontend address'), 'https://tracker.example.com/app');
    await user.click(screen.getByRole('button', { name: 'Make the kits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some settings need a change');
    expect(screen.getByLabelText('Backend address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Backend address')).toHaveAccessibleDescription(
      expect.stringContaining('Use https.'),
    );
    expect(screen.getByLabelText('Frontend address')).toHaveAccessibleDescription(
      expect.stringContaining('End the address with a slash'),
    );
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(errors).toEqual([]);
  });

  it('[OPS-016] (1) makes both kits with a seed, the bytes of the core run, and calls nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await fill(user);
    await user.click(screen.getByText('Reproducible secrets'));
    await user.type(screen.getByLabelText('Seed (optional)'), SEED);
    await user.click(screen.getByRole('button', { name: 'Make the kits' }));
    const backend = await screen.findByRole('link', { name: 'Download the backend kit' });
    expect(backend).toHaveAttribute('download', 'taskmoor-backend-kit.zip');
    const form = validateInputs({
      backendUrl: 'https://api.example.com',
      frontendUrl: 'https://tracker.example.com/',
    });
    if (!form.ok) throw new Error('inputs');
    const expected = await generateKits({
      inputs: form.inputs,
      user: {},
      secrets: await generateSecrets(seededRandom(SEED)),
      seed: '',
      web: WEB,
      version: '1.4.2',
    });
    expect(await bytesOf(backend.getAttribute('href'))).toEqual(hex(expected.outputs.backend));
    const frontend = screen.getByRole('link', { name: 'Download the frontend kit' });
    expect(await bytesOf(frontend.getAttribute('href'))).toEqual(hex(expected.outputs.frontend));
    const single = screen.getByRole('link', { name: 'Download the frontend as one file' });
    expect(await bytesOf(single.getAttribute('href'))).toEqual(hex(expected.outputs.single));
    expect(Object.keys(readZip(expected.outputs.frontend))).toContain('assets/app.js');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('[OPS-016] a saved project with a passphrase loads back and rebuilds the same kits', async () => {
    const user = userEvent.setup();
    renderPage();
    await fill(user);
    const passphrase = toBase64url(await systemRandom.bytes(18));
    await user.type(screen.getByLabelText('Passphrase (optional)'), passphrase);
    await user.click(screen.getByRole('button', { name: 'Make the kits' }));
    const first = await bytesOf(
      (await screen.findByRole('link', { name: 'Download the backend kit' })).getAttribute('href'),
    );
    await user.click(screen.getByRole('button', { name: 'Save project file' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('with the instance secrets'),
    );
    const project = [...blobs.values()].at(-1) as Blob;
    expect(project.type).toBe('application/json');
    const text = await project.text();
    expect(JSON.parse(text).secrets.cipher).toBe('AES-256-GCM');

    // A fresh page: the project and its passphrase give the same backend kit.
    cleanup();
    renderPage();
    await user.type(screen.getByLabelText('Passphrase (optional)'), passphrase);
    await user.upload(
      screen.getByLabelText('Load a project file'),
      new File([text], 'taskmoor-project.json', { type: 'application/json' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Backend address')).toHaveValue('https://api.example.com'),
    );
    await user.click(screen.getByRole('button', { name: 'Make the kits' }));
    const again = await screen.findByRole('link', { name: 'Download the backend kit' });
    expect(await bytesOf(again.getAttribute('href'))).toEqual(first);
  });

  it('[OPS-016] says when a project file is wrong or its secrets stay locked', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByLabelText('Load a project file');
    await user.upload(input, new File(['{"not":"a project"}'], 'x.json'));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a Taskmoor Builder project');

    const form = validateInputs({
      backendUrl: 'https://api.example.com',
      frontendUrl: 'https://tracker.example.com/',
    });
    if (!form.ok) throw new Error('inputs');
    const locked = await saveProject(form.inputs, {
      builderVersion: '1.4.2',
      secrets: { generated: await generateSecrets(systemRandom), user: {} },
      passphrase: toBase64url(await systemRandom.bytes(18)),
    });
    await user.upload(input, new File([locked], 'locked.json'));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Its secrets stay locked'),
    );
    await user.type(screen.getByLabelText('Passphrase (optional)'), 'not the passphrase');
    await user.upload(input, new File([locked], 'locked.json'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('does not open'));
  });

  it('[NFR-006] renders in Spanish from the catalogue', () => {
    const errors = renderPage('es');
    expect(screen.getByRole('button', { name: 'Preparar los kits' })).toBeInTheDocument();
    expect(screen.getByLabelText('Dirección del backend')).toBeInTheDocument();
    expect(errors).toEqual([]);
  });
});

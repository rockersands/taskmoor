import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';
import { timelineSvg } from './planImage';

vi.mock('./planImage', async (original) => {
  const actual = await original<typeof import('./planImage')>();
  return { ...actual, timelineSvg: vi.fn(actual.timelineSvg) };
});

class FailingImage {
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  set src(_url: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

describe('the Timeline as an image (PLN-014)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('[PLN-014] says the day it was made as people read it, in their language', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('Image', FailingImage);
    window.location.hash = '#/plans/12/timeline';
    const search = fakeListSearch();
    render(
      <I18nProvider locale="en">
        <PlanPage
          id={12}
          section="timeline"
          client={fakePlanClient()}
          search={search}
          list={fakeListClient(search)}
          now={() => new Date('2026-11-04T09:00:00Z')}
        />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Download' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Image (PNG)' }));
    await screen.findByRole('alert');
    expect(vi.mocked(timelineSvg).mock.lastCall?.[0].madeOn).toBe('Made on Nov 4, 2026');
  });
});

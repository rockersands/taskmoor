import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { setViewportWidth } from '../test/viewport';
import type { PlanSection } from './address';
import { type FakePlanOptions, fakePlanClient } from './fixtures';
import { PlanPage } from './PlanPage';

function renderPlan(section: PlanSection, hash: string, options: FakePlanOptions = {}) {
  window.location.hash = hash;
  const client = fakePlanClient(options);
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section={section}
        client={client}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return client;
}

/** Stands in for the browser's download: what would be saved, by name. */
function catchFiles() {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ name: this.download, blob: blobs.get(this.href) as Blob });
  });
  return saved;
}

/** A file's text: jsdom's Blob has no `text()`. */
const textOf = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });

/** A file's bytes, as the browser writes them to disk. */
const bytesOf = (blob: Blob) =>
  new Promise<Uint8Array>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });

let clipboard: { writeText: ReturnType<typeof vi.fn> };
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
});
afterEach(() => {
  window.location.hash = '';
  vi.restoreAllMocks();
});

const openDownload = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: 'Download' }));

describe('copying, linking and downloading a plan (PLN-014)', () => {
  it('[PLN-014] copies a link that holds the view as it stands, on every tab', async () => {
    const user = userEvent.setup({ writeToClipboard: false });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const hash = '#/plans/12/timeline?track=SHOP&group=type&zoom=months';
    renderPlan('timeline', hash);
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    const copied = String(clipboard.writeText.mock.calls[0]?.[0]);
    expect(copied.startsWith('http')).toBe(true);
    expect(copied).toContain(hash);
    expect(screen.getByText(/^Link copied\. It gives no access/)).toBeVisible();
  });

  it('[PLN-014] where the browser refuses the clipboard, a read-only field holds the link, selected', async () => {
    const user = userEvent.setup({ writeToClipboard: false });
    clipboard.writeText.mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    renderPlan('list', '#/plans/12/list?sort=due');
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    const field = await screen.findByLabelText<HTMLInputElement>('Link to this view');
    expect(field).toHaveAttribute('readonly');
    expect(field.value).toContain('#/plans/12/list?sort=due');
    expect(screen.getByText(/refused the clipboard/)).toBeVisible();
    await waitFor(() =>
      expect(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)).toBe(
        field.value,
      ),
    );
    // No clipboard at all, as on plain http.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByLabelText('Link to this view')).toBeVisible();
  });

  it('[PLN-014] moving through a view rewrites the address and does not read the plan again', async () => {
    const user = userEvent.setup();
    const client = renderPlan('timeline', '#/plans/12/timeline');
    await screen.findByRole('button', { name: 'Months' });
    const reads = client.planReads();
    const entries = window.history.length;
    await user.click(screen.getByRole('button', { name: 'Months' }));
    expect(screen.getByRole('button', { name: 'Months' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.hash).toBe('#/plans/12/timeline?zoom=months');
    await user.click(screen.getByRole('button', { name: 'Quarters' }));
    expect(window.location.hash).toBe('#/plans/12/timeline?zoom=quarters');
    expect(client.planReads()).toBe(reads);
    expect(window.history.length).toBe(entries);
    // The default says nothing in the address.
    await user.click(screen.getByRole('button', { name: 'Weeks' }));
    expect(window.location.hash).toBe('#/plans/12/timeline');
  });

  it('[PLN-014] a link opens the zoom it holds, and another can be chosen from there', async () => {
    const user = userEvent.setup();
    renderPlan('timeline', '#/plans/12/timeline?zoom=quarters');
    expect(await screen.findByRole('button', { name: 'Quarters' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Months' }));
    expect(screen.getByRole('button', { name: 'Months' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('[PLN-014] opens the month the link holds, and moving it rewrites the address', async () => {
    const user = userEvent.setup();
    const client = renderPlan('calendar', '#/plans/12/calendar?month=2027-02');
    expect(await screen.findByRole('heading', { name: 'February 2027' })).toBeVisible();
    const reads = client.planReads();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('heading', { name: 'March 2027' })).toBeVisible();
    expect(window.location.hash).toBe('#/plans/12/calendar?month=2027-03');
    expect(client.planReads()).toBe(reads);
  });

  it('[PLN-014] opens the periods the link holds on Capacity', async () => {
    const user = userEvent.setup();
    renderPlan('capacity', '#/plans/12/capacity?from=2027-01-04');
    expect(await screen.findByRole('heading', { name: /2027/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Later periods' }));
    await waitFor(() => expect(window.location.hash).toMatch(/from=2027-/));
    await user.click(screen.getByRole('button', { name: 'This period' }));
    await waitFor(() => expect(window.location.hash).toBe('#/plans/12/capacity'));
  });

  it("[PLN-014] the List's file is the server's, with its filters, columns and order, and holds every ticket", async () => {
    const user = userEvent.setup();
    renderPlan('list', '#/plans/12/list?track=SHOP&sort=due');
    await openDownload(user);
    const link = await screen.findByRole('menuitem', { name: 'CSV' });
    const url = new URL(link.getAttribute('href') as string, 'http://x.test');
    expect(url.pathname).toBe('/api/v1/plans/12/export');
    expect(url.searchParams.get('track')).toBe('SHOP');
    expect(url.searchParams.get('sort')).toBe('due');
    expect(url.searchParams.get('columns')?.startsWith('key,')).toBe(true);
    expect(link).toHaveAttribute('download');
    expect(screen.getByText('The file holds every ticket of this plan you may see.')).toBeVisible();
  });

  it('[PLN-014] the Timeline reads again for a file, once, and hands it to the browser', async () => {
    const user = userEvent.setup();
    const saved = catchFiles();
    const client = renderPlan('timeline', '#/plans/12/timeline?track=SHOP');
    await openDownload(user);
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    expect(
      await screen.findByText(/^Downloaded Spring-launch-timeline-2026-11-04\.csv/),
    ).toBeVisible();
    expect(client.exportReads()).toBe(1);
    expect(saved.map((f) => f.name)).toEqual(['Spring-launch-timeline-2026-11-04.csv']);
    const text = await textOf(saved[0]?.blob as Blob);
    expect(text).toContain('SHOP-2');
    expect(text).not.toContain('OPS-4,');
  });

  it('[PLN-014] says so in words when the browser cannot draw the image, and no file comes', async () => {
    const user = userEvent.setup();
    const saved = catchFiles();
    class FailingImage {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_url: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailingImage);
    try {
      const client = renderPlan('timeline', '#/plans/12/timeline');
      await openDownload(user);
      await user.click(await screen.findByRole('menuitem', { name: 'Image (PNG)' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This browser could not draw the image',
      );
      expect(saved).toEqual([]);
      expect(client.exportReads()).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('[PLN-014] every view offers its file; counts need no second read', async () => {
    const user = userEvent.setup();
    const saved = catchFiles();
    const client = renderPlan('summary', '#/plans/12');
    await openDownload(user);
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.name).toBe('Spring-launch-summary-2026-11-04.csv');
    expect(client.exportReads()).toBe(0);
  });

  it('[PLN-014] the Releases tab hands over its file, made from what it already read', async () => {
    const user = userEvent.setup();
    const saved = catchFiles();
    const client = renderPlan('releases', '#/plans/12/releases');
    await openDownload(user);
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.name).toBe('Spring-launch-releases-2026-11-04.csv');
    expect(client.exportReads()).toBe(0);
  });

  it('[PLN-014] the Calendar reads again for its file, named for its month', async () => {
    const user = userEvent.setup();
    const saved = catchFiles();
    const client = renderPlan('calendar', '#/plans/12/calendar');
    await openDownload(user);
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.name).toBe('Spring-launch-calendar-2026-11.csv');
    expect(client.exportReads()).toBe(1);
  });

  it('[PLN-014] the Capacity file comes from the view', async () => {
    const user = userEvent.setup();
    const saved = catchFiles();
    renderPlan('capacity', '#/plans/12/capacity');
    await openDownload(user);
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(await textOf(saved[0]?.blob as Blob)).toContain('counted by whole weeks');
  });

  it('[PLN-014] every file a view makes starts with one UTF-8 byte-order mark, for Excel on Windows', async () => {
    const views: [PlanSection, string][] = [
      ['summary', '#/plans/12'],
      ['timeline', '#/plans/12/timeline'],
      ['calendar', '#/plans/12/calendar'],
      ['capacity', '#/plans/12/capacity'],
      ['releases', '#/plans/12/releases'],
    ];
    for (const [section, hash] of views) {
      const user = userEvent.setup();
      const saved = catchFiles();
      renderPlan(section, hash);
      await openDownload(user);
      await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
      await waitFor(() => expect(saved).toHaveLength(1));
      const file = saved[0]?.blob as Blob;
      expect(file.type, section).toBe('text/csv; charset=utf-8');
      const bytes = await bytesOf(file);
      // EF BB BF once, then the header's first letter: never a second mark.
      expect([...bytes.slice(0, 3)], section).toEqual([0xef, 0xbb, 0xbf]);
      expect([...bytes.slice(3, 6)], section).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(String.fromCharCode(bytes[3] ?? 0), section).toMatch(/[A-Z]/);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('[PLN-014] says the file stops at 10,000 and the image at 400', async () => {
    const { manyPlanItems } = await import('./fixtures');
    renderPlan('timeline', '#/plans/12/timeline', { items: manyPlanItems(10_001) });
    expect(await screen.findByText(/^The file holds the first 10,000 tickets/)).toBeVisible();
    expect(
      screen.getByText('First 400 of 10,000 rows: filter the plan for the rest.'),
    ).toBeVisible();
  });

  it('[PLN-014] duplicates a plan under a name it offers, then opens the copy', async () => {
    const user = userEvent.setup();
    const client = renderPlan('summary', '#/plans/12');
    await user.click(await screen.findByRole('button', { name: 'Duplicate plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate Spring launch' });
    expect(dialog).toHaveTextContent('It takes no shares and no capacity');
    const name = screen.getByLabelText<HTMLInputElement>('Name');
    expect(name.value).toBe('Copy of Spring launch');
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the copy a name.');
    await user.type(name, 'Autumn launch');
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(window.location.hash).toBe('#/plans/99'));
    expect(client.duplicated).toEqual(['Autumn launch']);
  });

  it('[PLN-014] says how many sources stayed behind, never which', async () => {
    const user = userEvent.setup();
    renderPlan('summary', '#/plans/12', { hidden: 2 });
    await user.click(await screen.findByRole('button', { name: 'Duplicate plan' }));
    expect(await screen.findByText('2 sources hidden from you stay behind.')).toBeVisible();
    const dialog = screen.getByRole('dialog');
    const before = within(dialog).getByRole('status');
    expect(before).toBeEmptyDOMElement();
    await user.type(screen.getByLabelText('Name'), '{Enter}');
    const heading = await screen.findByRole('heading', { name: 'Plan copied' });
    expect(heading).toBeVisible();
    // Focus does not fall to the page's body, and the line was there to be read out when it changed.
    expect(heading).toHaveFocus();
    expect(within(dialog).getByRole('status')).toBe(before);
    expect(before).toHaveTextContent('2 sources you may not see were left out.');
    expect(screen.getByRole('link', { name: 'Open the copy' })).toHaveAttribute(
      'href',
      expect.stringContaining('/plans/99'),
    );
    await user.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[PLN-014] says so when a copy is refused', async () => {
    const user = userEvent.setup();
    renderPlan('summary', '#/plans/12');
    await user.click(await screen.findByRole('button', { name: 'Duplicate plan' }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Refused');
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be copied');
    expect(window.location.hash).toBe('#/plans/12');
  });

  it('[PLN-014] anyone who sees the plan may copy it, editable or not', async () => {
    renderPlan('summary', '#/plans/12', { editable: false });
    expect(await screen.findByRole('button', { name: 'Duplicate plan' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeVisible();
  });

  it('[PLN-014] offers its download menu on a phone', async () => {
    const user = userEvent.setup();
    setViewportWidth(375);
    renderPlan('list', '#/plans/12/list');
    await openDownload(user);
    expect(await screen.findByRole('menuitem', { name: 'CSV' })).toBeVisible();
  });
});

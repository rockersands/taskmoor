import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { useTimeZone } from '../test/timeZone';
import { setViewportWidth } from '../test/viewport';
import { fakeTrackClient } from '../tracks/fixtures';
import { fakeCrossTrackClient } from './crossTrackFixtures';
import { fakeReleaseClient } from './fixtures';
import { ReleasePage } from './ReleasePage';

function renderRelease(
  releaseId = 2,
  client = fakeReleaseClient({ approver: true }),
  locale: Locale = 'en',
) {
  render(
    <I18nProvider locale={locale}>
      <ReleasePage
        releaseId={releaseId}
        client={client}
        now={() => new Date('2026-10-30T09:00:00Z')}
        tracks={fakeTrackClient()}
      />
    </I18nProvider>,
  );
  return client;
}
const section = (name: string) => within(screen.getByRole('region', { name }));
const searchOf = (href: string | null) => new URLSearchParams(href?.split('?')[1]).get('q');

describe('a release in a release across tracks (PLN-007)', () => {
  it('[PLN-007] names it in the facts, says out of step in words, and Align is the release’s own change', async () => {
    const user = userEvent.setup();
    const client = fakeReleaseClient({ linked: true });
    const setDate = vi.spyOn(client, 'setDate');
    renderRelease(3, client);
    const link = await screen.findByRole('link', { name: 'Spring launch' });
    expect(link.getAttribute('href')).toContain('#/cross-track-releases/5');
    const warnings = section('Warnings');
    expect(
      warnings.getByText('Out of step with Spring launch, which ends on Dec 20, 2026.'),
    ).toBeVisible();
    await user.click(warnings.getByRole('button', { name: 'Align to Dec 20, 2026' }));
    await waitFor(() => expect(setDate).toHaveBeenCalledWith(3, '2026-12-20'));
    expect(await screen.findByText('This release now ends on Dec 20, 2026.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Warnings' })).toBeNull());
  });

  it('[PLN-007] keeps Align and Remove to the track’s administrators', async () => {
    renderRelease(3, fakeReleaseClient({ linked: true, mayManage: false }));
    expect(await screen.findByRole('link', { name: 'Spring launch' })).toBeVisible();
    expect(
      section('Warnings').getByText('Out of step with Spring launch, which ends on Dec 20, 2026.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /Align to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove from/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add to a release across tracks/ })).toBeNull();
  });

  it('[PLN-007] adds an upcoming release to one, and offers only those its track is not yet in', async () => {
    const user = userEvent.setup();
    const crossTrack = fakeCrossTrackClient();
    const link = vi.spyOn(crossTrack, 'link');
    crossTrack.list = async () => ({
      releases: [
        {
          id: 8,
          name: 'Autumn launch',
          endRule: 'work_complete',
          date: null,
          state: 'upcoming',
          owner: { id: 3, name: 'Ana Ruiz' },
          tracks: [{ id: 2, key: 'OPS', name: 'Operations' }],
          progress: { tickets: 0, closed: 0, open: 0 },
          hidden: { releases: 0, open: 0 },
          version: 1,
        },
        {
          id: 9,
          name: 'Has this track',
          endRule: 'work_complete',
          date: null,
          state: 'upcoming',
          owner: { id: 3, name: 'Ana Ruiz' },
          tracks: [{ id: 1, key: 'CHK', name: 'Checkout' }],
          progress: { tickets: 0, closed: 0, open: 0 },
          hidden: { releases: 0, open: 0 },
          version: 1,
        },
      ],
      next: null,
    });
    crossTrack.link = async (...args) => {
      link(...args);
      return { ok: false, code: 'not_found' };
    };
    render(
      <I18nProvider locale="en">
        <ReleasePage releaseId={3} client={fakeReleaseClient()} crossTrack={crossTrack} />
      </I18nProvider>,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Add to a release across tracks…' }),
    );
    const select = await screen.findByLabelText('Which one to join');
    expect(within(select).queryByRole('option', { name: 'Has this track' })).toBeNull();
    await user.selectOptions(select, 'Autumn launch');
    await user.click(screen.getByRole('button', { name: 'Link it' }));
    await waitFor(() => expect(link).toHaveBeenCalledWith(8, 3));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be linked');
  });

  it('[PLN-007] offers every one the person sees, however many pages, and the way to the list', async () => {
    const user = userEvent.setup();
    const base = fakeCrossTrackClient();
    const [row] = (await base.list('upcoming')).releases;
    const rowNamed = (id: number, name: string) => ({
      ...(row as NonNullable<typeof row>),
      id,
      name,
      tracks: [],
    });
    const crossTrack = {
      ...base,
      list: vi.fn(async (_state: 'upcoming' | 'shipped', cursor?: string) =>
        cursor
          ? { releases: [rowNamed(9, 'On the second page')], next: null }
          : { releases: [rowNamed(8, 'On the first page')], next: 'next-page' },
      ),
    };
    render(
      <I18nProvider locale="en">
        <ReleasePage releaseId={3} client={fakeReleaseClient()} crossTrack={crossTrack} />
      </I18nProvider>,
    );
    const add = await screen.findByRole('button', { name: 'Add to a release across tracks…' });
    expect(screen.getByRole('link', { name: 'Releases across tracks' })).toHaveAttribute(
      'href',
      expect.stringContaining('#/cross-track-releases'),
    );
    await user.click(add);
    const select = await screen.findByLabelText('Which one to join');
    expect(within(select).getByRole('option', { name: 'On the first page' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'On the second page' })).toBeInTheDocument();
  });

  it('[PLN-007] tells an outage from none to join, and says when Align got no answer', async () => {
    const user = userEvent.setup();
    const crossTrack = {
      ...fakeCrossTrackClient(),
      list: async () => {
        throw new Error('down');
      },
    };
    render(
      <I18nProvider locale="en">
        <ReleasePage releaseId={3} client={fakeReleaseClient()} crossTrack={crossTrack} />
      </I18nProvider>,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Add to a release across tracks…' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The releases across tracks could not be read.',
    );
    expect(screen.queryByText('None to join')).toBeNull();
    cleanup();
    const client = fakeReleaseClient({ linked: true });
    client.setDate = async () => {
      throw new TypeError('Failed to fetch');
    };
    render(
      <I18nProvider locale="en">
        <ReleasePage releaseId={3} client={client} crossTrack={fakeCrossTrackClient()} />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Align to/ }));
    expect(await screen.findByText('The date could not be changed.')).toBeVisible();
  });
});

describe('a release’s page (M1-050)', () => {
  it('[CORE-016] shows the tickets by stage, each number opening the search that finds them', async () => {
    renderRelease();
    expect(await screen.findByRole('heading', { level: 1, name: '2.0' })).toBeVisible();
    const progress = section('Progress');
    const closed = progress.getByRole('link', { name: 'Closed 1, open the search' });
    expect(searchOf(closed.getAttribute('href'))).toBe('targetRelease = 2 AND stage = closed');
    expect(progress.getByRole('link', { name: 'New 2, open the search' })).toBeVisible();
    const warnings = section('Warnings');
    expect(
      warnings.getByText('3 tickets are still open and the release date has passed.'),
    ).toBeVisible();
    expect(
      searchOf(warnings.getByRole('link', { name: 'Show these tickets' }).getAttribute('href')),
    ).toBe('targetRelease = 2 AND stage != closed');
    expect(warnings.getByText('1 approval is still to come.')).toBeVisible();
    const rows = section('Tickets').getAllByRole('row');
    expect(rows.map((r) => within(r).queryByRole('link')?.textContent ?? null)).toEqual([
      null,
      'CHK-21',
      'CHK-22',
      'CHK-23',
      'CHK-24',
    ]);
    expect(within(rows[3] as HTMLElement).getByText('Unassigned')).toBeVisible();
  });

  it('[CORE-016] ships only once approved, moving the open tickets to the next release', async () => {
    const user = userEvent.setup();
    const client = renderRelease();
    await screen.findByRole('heading', { level: 1, name: '2.0' });
    expect(screen.queryByRole('region', { name: 'Ship 2.0?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Ship this release…' }));
    const shipping = section('Ship 2.0?');
    expect(screen.getByRole('heading', { name: 'Ship 2.0?' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Ship this release…' })).toBeNull();
    expect(shipping.getByLabelText('Ship on')).toHaveValue('2026-10-30');
    await user.click(await shipping.findByRole('radio', { name: 'Move them to 2.1' }));
    await user.click(shipping.getByRole('button', { name: 'Ship 2.0' }));
    expect(await shipping.findByRole('alert')).toHaveTextContent('Every approver must approve');
    // The approver approves on the same page.
    const approvals = section('Approvals');
    await user.type(approvals.getByRole('textbox', { name: 'Comment (optional)' }), 'Go');
    await user.click(approvals.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approvals.getByText('Approved')).toBeVisible());
    expect(screen.getByRole('status')).toHaveTextContent('You approved this release.');
    await user.click(shipping.getByRole('button', { name: 'Ship 2.0' }));
    await waitFor(() =>
      expect(screen.getByText('Shipped', { selector: '.release-state' })).toBeVisible(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('2.0 shipped.');
    // Ship is gone: focus lands on the page's name, with the notice under it.
    expect(screen.getByRole('heading', { level: 1, name: '2.0' })).toHaveFocus();
    expect(client.releases().find((r) => r.name === '2.1')?.progress.open).toBe(4);
    expect(screen.queryByRole('region', { name: 'Ship 2.0?' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ship this release…' })).toBeNull();
  });

  it('[CORE-016] names each left-out reason in words, a seeded one in the person’s language (T-299)', async () => {
    const client = fakeReleaseClient();
    const notes = client.notes.bind(client);
    client.notes = async (id) => ({
      ...(await notes(id)),
      leftOut: [
        { reason: 'Not planned', count: 1 },
        { reason: 'Superseded', count: 3 },
        { reason: '', count: 1 },
      ],
    });
    renderRelease(1, client, 'es');
    const section = within(await screen.findByRole('region', { name: 'Notas de la versión' }));
    // A reason someone named shows as they wrote it; one since deleted is said so.
    expect(
      await section.findByText(
        'Excluidos (cerrados sin estar hechos): 1 ticket como No planificado, 3 tickets como Superseded y 1 ticket con un motivo de cierre ya borrado.',
      ),
    ).toBeVisible();
  });

  it('[CORE-016] heads the notes and names the tickets’ types in the person’s language, a type someone named as written (T-351)', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const client = fakeReleaseClient();
    const notes = client.notes.bind(client);
    client.notes = async (id) => {
      const read = await notes(id);
      return {
        ...read,
        sections: [
          ...read.sections,
          { type: 'Spike', tickets: [{ id: 27, key: 'CHK-27', summary: 'Try a wallet' }] },
        ],
      };
    };
    renderRelease(1, client, 'es');
    const section = within(await screen.findByRole('region', { name: 'Notas de la versión' }));
    const headings = await section.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Funcionalidad', 'Error', 'Spike']);
    expect(section.getByRole('link', { name: 'CHK-26' }).closest('section')).toHaveAccessibleName(
      'Error',
    );
    // The Markdown keeps the stored names, in English as the manual says.
    await user.click(section.getByRole('button', { name: 'Copiar como Markdown' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('## Feature\n'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('## Bug\n'));
  });

  it('[CORE-016] gives each ticket’s type in the person’s language in the release’s tickets (T-351)', async () => {
    renderRelease(2, fakeReleaseClient({ approver: true }), 'es');
    const tickets = within(await screen.findByRole('region', { name: 'Tickets' }));
    const row = (key: string) => tickets.getByRole('link', { name: key }).closest('tr');
    expect(within(row('CHK-21') as HTMLElement).getByText('Funcionalidad')).toBeVisible();
    expect(within(row('CHK-24') as HTMLElement).getByText('Tarea')).toBeVisible();
  });

  it('[CORE-016] gives focus back to Ship when the shipping step is cancelled', async () => {
    const user = userEvent.setup();
    renderRelease();
    await screen.findByRole('heading', { level: 1, name: '2.0' });
    await user.click(screen.getByRole('button', { name: 'Ship this release…' }));
    await user.click(section('Ship 2.0?').getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Ship 2.0?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ship this release…' })).toHaveFocus();
  });

  it('[CORE-016] shows the generated notes, to copy as Markdown or download', async () => {
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: 'America/Chicago',
    });
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderRelease(1);
    const notes = within(await screen.findByRole('region', { name: 'Release notes' }));
    expect(await notes.findByRole('heading', { name: 'Feature', level: 3 })).toBeVisible();
    expect(notes.getByRole('link', { name: 'CHK-26' }).closest('li')).toHaveTextContent(
      'CHK-26 Totals off by a cent',
    );
    expect(
      notes.getByText(
        'Left out (closed without being done): 1 ticket as Duplicate and 2 tickets as Not planned.',
      ),
    ).toBeVisible();
    await user.click(notes.getByRole('button', { name: 'Copy as Markdown' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('## Bug\n\n- CHK-26'));
    expect(await screen.findByText('Release notes copied.')).toBeVisible();
    // The file's link names the browser's zone, which a download cannot send as a header (T-277).
    expect(notes.getByRole('link', { name: 'Download Markdown' })).toHaveAttribute(
      'href',
      '/api/v1/releases/1/notes?format=markdown&timeZone=America%2FChicago',
    );
    // Shipped: no way to ship it again, the day it shipped.
    expect(screen.queryByRole('button', { name: 'Ship this release…' })).toBeNull();
    expect(screen.getByText('Shipped on').nextElementSibling).toHaveTextContent('Oct 1, 2026');
    zone.mockRestore();
  });

  it('[CORE-016] draws no empty progress for a release with no tickets, and says why once (S3-WK-5)', async () => {
    renderRelease(4);
    const tickets = within(await screen.findByRole('region', { name: 'Tickets' }));
    expect(tickets.getByText('No tickets target this release.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Progress' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^New 0/ })).toBeNull();
  });

  it('[CORE-016] offers no Markdown to copy or download while the notes are empty (D27)', async () => {
    renderRelease(3);
    const notes = within(await screen.findByRole('region', { name: 'Release notes' }));
    expect(
      notes.getByText('No closed tickets yet: the notes fill in as tickets close.'),
    ).toBeVisible();
    expect(notes.queryByRole('button', { name: 'Copy as Markdown' })).toBeNull();
    expect(notes.queryByRole('link', { name: 'Download Markdown' })).toBeNull();
  });

  it('[CORE-016] sits under its track’s tab bar with Releases marked, titled by its name under the track (T-215, D26, D7)', async () => {
    renderRelease();
    const heading = await screen.findByRole('heading', { level: 1, name: '2.0' });
    const header = heading.closest('header') as HTMLElement;
    expect(within(header).getByText('Checkout', { exact: false })).toBeVisible();
    expect(within(header).queryByRole('link')).toBeNull();
    const bar = await screen.findByRole('navigation', { name: /^Sections of / });
    expect(within(bar).getByRole('link', { name: 'Releases' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Shipping is an ordinary primary action beside the title (D27).
    expect(within(header).getByRole('button', { name: 'Ship this release…' })).toHaveClass(
      'button-primary',
    );
    expect(within(header).getByRole('button', { name: 'What is 2.0 for?' })).toBeVisible();
  });

  it('[CORE-016] asks for nothing more once the release is not there, and says so on a not-found page (PL-50, D4)', async () => {
    const client = fakeReleaseClient({ approver: true });
    client.get = async () => {
      throw new ApiError(404, { error: 'not_found' });
    };
    client.overview = vi.fn(client.overview);
    client.notes = vi.fn(client.notes);
    renderRelease(999, client);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Release not found' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    expect(client.overview).not.toHaveBeenCalled();
    expect(client.notes).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: /^Sections of / })).toBeNull();
  });

  it('[CORE-016] keeps its header when it cannot be read, with the alert under it (UI-T22)', async () => {
    const client = fakeReleaseClient({ approver: true });
    client.get = async () => {
      throw new ApiError(500, { error: 'internal' });
    };
    renderRelease(2, client);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Release' });
    expect(screen.getByRole('alert')).toHaveTextContent('This release could not be loaded.');
    expect(heading.closest('section')).toContainElement(screen.getByRole('alert'));
    expect(screen.queryByRole('heading', { name: 'Release not found' })).toBeNull();
  });

  it('[CORE-016] keeps its name and its track’s tab bar when only its numbers fail (UI-T22)', async () => {
    const client = fakeReleaseClient({ approver: true });
    client.overview = async () => {
      throw new ApiError(500, { error: 'internal' });
    };
    renderRelease(2, client);
    expect(await screen.findByRole('alert')).toHaveTextContent('This release could not be loaded.');
    expect(screen.getByRole('heading', { level: 1, name: '2.0' })).toBeVisible();
    const bar = await screen.findByRole('navigation', { name: /^Sections of / });
    expect(within(bar).getByRole('link', { name: 'Releases' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('[CORE-016] fits a phone: nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderRelease();
    await screen.findByRole('heading', { level: 1, name: '2.0' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});

// A release's own dates read as its Releases list and its release across tracks do: in the
// person's locale, never `2026-12-01`, and the same calendar day on a clock behind UTC (T-240).
describe('a release’s own dates in the person’s locale (T-240, TR-29)', () => {
  useTimeZone('America/Los_Angeles');

  /** Release 3 starts on 2 November; release 1 shipped late on 30 September, Los Angeles time. */
  function datedClient() {
    const client = fakeReleaseClient();
    const get = client.get.bind(client);
    vi.spyOn(client, 'get').mockImplementation(async (id) =>
      id === 1
        ? { ...(await get(1)), releaseDate: null, shippedAt: '2026-10-01T03:00:00Z' }
        : { ...(await get(id)), startDate: '2026-11-02' },
    );
    return client;
  }
  const renderIn = (locale: 'en' | 'es', releaseId: number) =>
    render(
      <I18nProvider locale={locale}>
        <ReleasePage
          releaseId={releaseId}
          client={datedClient()}
          now={() => new Date('2026-10-30T09:00:00Z')}
          tracks={fakeTrackClient()}
        />
      </I18nProvider>,
    );
  const fact = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling;

  it('[NFR-006] [CORE-016] reads the start and release dates in English', async () => {
    renderIn('en', 3);
    await screen.findByRole('heading', { level: 1, name: '2.1' });
    expect(fact('Start date')).toHaveTextContent(/^Nov 2, 2026$/);
    expect(fact('Release date')).toHaveTextContent(/^Dec 1, 2026$/);
  });

  it('[NFR-006] [CORE-016] reads the start and release dates in Spanish', async () => {
    renderIn('es', 3);
    await screen.findByRole('heading', { level: 1, name: '2.1' });
    expect(fact('Fecha de inicio')).toHaveTextContent(/^2 nov 2026$/);
    expect(fact('Fecha de la versión')).toHaveTextContent(/^1 dic 2026$/);
  });

  it('[NFR-006] [CORE-016] reads the day a release shipped on the person’s own clock', async () => {
    renderIn('en', 1);
    await screen.findByRole('heading', { level: 1, name: '1.9' });
    expect(fact('Shipped on')).toHaveTextContent(/^Sep 30, 2026$/);
    cleanup();
    renderIn('es', 1);
    await screen.findByRole('heading', { level: 1, name: '1.9' });
    expect(fact('Entregada el')).toHaveTextContent(/^30 sept 2026$/);
  });
});

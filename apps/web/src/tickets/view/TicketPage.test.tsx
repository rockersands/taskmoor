import { writeDocToYDoc } from '@taskmoor/richtext';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MEMBER } from '../../admin/fixtures';
import { ApiError } from '../../api/client';
import { fakeAttachmentClient } from '../../attachments/fixtures';
import { fakeCommentClient } from '../../comments/fixtures';
import { I18nProvider } from '../../i18n/I18nProvider';
import { type Locale, messagesFor } from '../../i18n/locale';
import type { Connect } from '../../richtext/CollaborativeEditor';
import { rememberBoard } from '../../routing/cameFrom';
import { addressRoute, currentRoute, overlayRoute, router } from '../../routing/router';
import { type Session, SessionProvider } from '../../session/SessionProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { applyStylesheet } from '../../test/stylesheets';
import { useTimeZone } from '../../test/timeZone';
import { setRootFontSize, setViewportWidth } from '../../test/viewport';
import { fakeCloneClient } from '../clone/fixtures';
import type { NamedField } from '../customFieldNames';
import type { TicketToolsClient } from '../tools/client';
import { fakeToolsClient } from '../tools/fixtures';
import type { TicketDetails } from './client';
import {
  type FakeTicketClient,
  fakeTicketClient,
  SHOP_41,
  SHOP_41_SOME_FIELDS,
  SHOP_FIELDS,
  type TicketAccess,
  TRANSITIONS,
} from './fixtures';
import { TicketPage, ticketEditorTools } from './TicketPage';

const member = MEMBER as Extract<Session, { status: 'signed-in' }>;
const ADA_SESSION_ID = 1;
const ADA_SESSION: Session = {
  status: 'signed-in',
  user: { ...member.user, id: ADA_SESSION_ID, name: 'Ada Lovelace' },
};

const inPage: Connect = (_name, onStatus) => {
  const document = new Y.Doc();
  if (SHOP_41.description) writeDocToYDoc(document, SHOP_41.description);
  queueMicrotask(() => onStatus('live'));
  return { document, provider: null, destroy: () => document.destroy() };
};

function renderPage(
  start: Parameters<typeof fakeTicketClient>[0] = {},
  locale: Locale = 'en',
  /** The app around the page, such as its navigation. */
  around: React.ReactNode = null,
  /** Links, subtickets and checklists; the page's own by default. */
  tools?: TicketToolsClient,
) {
  const client = fakeTicketClient(start);
  const comments = fakeCommentClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={ADA_SESSION}>
        {around}
        <main>
          <TicketPage
            ticket="SHOP-41"
            client={client}
            comments={comments}
            attachments={fakeAttachmentClient()}
            clone={fakeCloneClient().client}
            connect={inPage}
            mentions={() => async () => []}
            {...(tools ? { tools } : {})}
          />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, comments };
}

const details = () => screen.getByRole('region', { name: 'Details' });
const heading = () => screen.findByRole('heading', { level: 1 });

describe('the ticket view (M1-051)', () => {
  it('[CORE-014] offers no empty priority; an imported ticket with none asks for one', async () => {
    renderPage();
    await heading();
    const user = userEvent.setup();
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Highest', 'High', 'Medium']);
    cleanup();
    renderPage({ ticket: { ...SHOP_41, priority: null } });
    await heading();
    expect(within(details()).getByRole('combobox', { name: 'Priority' })).toHaveTextContent(
      'Choose a priority',
    );
  });

  it('[CORE-022] shows the ticket: summary, details, links, attachments and comments', async () => {
    renderPage();
    expect(await heading()).toHaveTextContent('SHOP-41 Checkout fails for expired cards');
    expect(screen.getByText('Shop · Bug')).toBeVisible();
    const facts = details();
    expect(within(facts).getByText('Grace Hopper')).toBeVisible();
    expect(within(facts).getByRole('combobox', { name: 'Priority' })).toHaveTextContent('High');
    expect(within(facts).getByText('payments, checkout')).toBeVisible();
    expect(within(facts).getByLabelText('Due date')).toHaveValue('2026-11-02');
    expect(within(facts).getByRole('link', { name: 'SHOP-40 Card payments' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-40',
    );
    const links = await screen.findByRole('region', { name: 'Links' });
    expect(within(links).getByRole('link', { name: 'SHOP-39' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Attachments' })).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Comments' })).toBeVisible();
    // Its status as one control, follow and vote, as the backend offers them.
    expect(await screen.findByRole('button', { name: /^Status: / })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Follow (2)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('[CORE-022] leads back to the board it was opened from, and only then', async () => {
    window.sessionStorage.clear();
    renderPage();
    await heading();
    expect(screen.queryByRole('link', { name: /^Back to/ })).toBeNull();
    cleanup();
    rememberBoard('SHOP-41', { id: 7, name: 'Checkout team' });
    renderPage();
    await heading();
    expect(screen.getByRole('link', { name: 'Back to Checkout team' })).toHaveAttribute(
      'href',
      '#/boards/7',
    );
    window.sessionStorage.clear();
  });

  it('[CORE-022] edits the summary, priority, labels and dates in place', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await heading();
    await user.click(screen.getByRole('button', { name: 'Edit summary' }));
    const summary = screen.getByRole('textbox', { name: 'Summary' });
    expect(summary).toHaveFocus();
    await user.clear(summary);
    await user.type(summary, 'Expired cards fail silently{Enter}');
    expect(await heading()).toHaveTextContent('SHOP-41 Expired cards fail silently');
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Highest' }));
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    await user.clear(labels);
    await user.type(labels, 'payments, urgent');
    await user.click(within(details()).getByRole('button', { name: 'Save' }));
    expect(await within(details()).findByText('payments, urgent')).toBeVisible();
    fireEvent.change(within(details()).getByLabelText('Due date'), {
      target: { value: '2026-11-09' },
    });
    expect(
      client.calls.filter((c) => c.action === 'edit').map((c) => (c.args as unknown[])[1]),
    ).toEqual([
      { summary: 'Expired cards fail silently' },
      { priorityId: 1 },
      { labels: ['payments', 'urgent'] },
      { dueDate: '2026-11-09' },
    ]);
  });

  it('[WF-006] moves at once when the status needs nothing, and lists only other statuses', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    const control = await screen.findByRole('button', { name: /^Status: / });
    expect(control).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(control);
    const menu = screen.getByRole('menu');
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(names).not.toContain(SHOP_41.status.name);
    await user.click(within(menu).getByRole('menuitem', { name: 'In review' }));
    expect(await screen.findByText(/^Moved to /)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /what it needs/ })).toBeNull();
    expect(client.calls.find((c) => c.action === 'transition')?.args[1]).toBe(2);
  });

  it('[WF-006] says in plain words why a transition was refused', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    client.transition = async () => {
      throw new ApiError(409, {
        error: 'transition_refused',
        by: 'guard',
        name: 'only-assignee',
      });
    };
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'In review' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('transition_refused');
    expect(alert).not.toHaveTextContent('The workflow does not let');
  });

  it('[CORE-022][CORE-015][CORE-016] names a choice the track does not offer, or an archived one, as the create form does (T-287, T-286)', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await heading();
    const refuse = (code: string) => {
      client.edit = async () => {
        throw new ApiError(400, { error: 'invalid_fields', fields: { priorityId: code } });
      };
    };
    refuse('not_in_track');
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Highest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This track does not offer this choice. Choose one of its own.',
    );
    // A release or an area says which it is (T-286); the priority keeps the general words.
    client.edit = async () => {
      throw new ApiError(400, {
        error: 'invalid_fields',
        fields: { targetReleaseIds: 'not_in_track', areaIds: 'not_in_track' },
      });
    };
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Medium' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Target releases: This release is not in this track. Choose one of its releases. ' +
          'Areas: This area is not in this track. Choose one of its areas.',
      ),
    );
    refuse('archived');
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Medium' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This release or area is archived. Choose another.',
      ),
    );
    // Any other refused value still names the fields to check, by their labels (T-292).
    refuse('invalid');
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Highest' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Check these values. Priority: This value is not valid here.',
      ),
    );
  });

  it('[CORE-008] names refused fields by their labels and says why each was refused, never by API keys (T-292)', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await heading();
    // Points is on the ticket's edit form, so the page knows its name.
    await within(details()).findByRole('spinbutton', { name: 'Points' });
    client.edit = async () => {
      throw new ApiError(400, {
        error: 'invalid_fields',
        fields: {
          dueDate: 'invalid',
          'fields.31': 'out_of_range',
          'fields.77': 'required',
          // Not in the track's field catalogue either.
          'fields.99': 'invalid',
          targetReleaseIds: 'archived',
          // A key the page cannot name is left out, never shown as it is.
          weird: 'unknown',
        },
      });
    };
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Highest' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Check these values. Due date: This value is not valid here. ' +
        'Points: This number is out of range. ' +
        'Customer tier: This field is required. ' +
        'A custom field: This value is not valid here. ' +
        'Target releases: This release or area is archived. Choose another.',
    );
    for (const key of ['dueDate', 'fields.', 'targetReleaseIds', 'weird']) {
      expect(alert).not.toHaveTextContent(key);
    }
    // Only keys it cannot name: the general message.
    client.edit = async () => {
      throw new ApiError(400, { error: 'invalid_fields', fields: { weird: 'unknown' } });
    };
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Medium' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'That did not work. Try again in a moment.',
      ),
    );
  });

  it("[CORE-008] names a custom field off the edit form from the track's catalogue, read once while the page is open (T-297)", async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await heading();
    await within(details()).findByRole('spinbutton', { name: 'Points' });
    const refuse = (fields: Record<string, string>) => {
      client.edit = async () => {
        throw new ApiError(400, { error: 'invalid_fields', fields });
      };
    };
    const choose = async (priority: string) => {
      await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
      await user.click(screen.getByRole('option', { name: priority }));
    };
    const reads = () => client.calls.filter((c) => c.action === 'fieldNames');
    // A field the edit form names needs no read.
    refuse({ 'fields.31': 'required' });
    await choose('Highest');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check these values. Points: This field is required.',
    );
    expect(reads()).toEqual([]);
    // One it does not: the track's catalogue (by its id) is read for its name.
    refuse({ 'fields.77': 'required' });
    await choose('Medium');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Check these values. Customer tier: This field is required.',
      ),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('A custom field');
    // Again: named at once from what was read.
    refuse({ 'fields.77': 'invalid' });
    await choose('Highest');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Check these values. Customer tier: This value is not valid here.',
      ),
    );
    expect(reads()).toEqual([{ action: 'fieldNames', args: [3] }]);
  });

  it("[CORE-008] says 'A custom field' only when the track's catalogue cannot be read (T-297)", async () => {
    const user = userEvent.setup();
    const { client } = renderPage({ fields: new ApiError(404, { error: 'not_found' }) });
    await heading();
    await within(details()).findByRole('spinbutton', { name: 'Points' });
    client.edit = async () => {
      throw new ApiError(400, {
        error: 'invalid_fields',
        fields: { 'fields.31': 'out_of_range', 'fields.77': 'required' },
      });
    };
    await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Highest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check these values. Points: This number is out of range. ' +
        'A custom field: This field is required.',
    );
  });

  it('[CORE-008] drops a refusal still waiting on the catalogue once a later edit goes through (T-297)', async () => {
    const user = userEvent.setup();
    // A large catalogue: the read is still under way when the next edit is made.
    let answer: (fields: NamedField[]) => void = () => {};
    const { client } = renderPage({
      fields: new Promise((resolve) => {
        answer = resolve;
      }),
    });
    await heading();
    await within(details()).findByRole('spinbutton', { name: 'Points' });
    const edit = client.edit;
    client.edit = async () => {
      throw new ApiError(400, { error: 'invalid_fields', fields: { 'fields.77': 'required' } });
    };
    const choose = async (priority: string) => {
      await user.click(within(details()).getByRole('combobox', { name: 'Priority' }));
      await user.click(screen.getByRole('option', { name: priority }));
    };
    await choose('Highest');
    await waitFor(() =>
      expect(client.calls.filter((c) => c.action === 'fieldNames')).toHaveLength(1),
    );
    // Another edit goes through before the catalogue answers.
    client.edit = edit;
    await choose('Medium');
    expect(await screen.findByText('Saved.')).toBeVisible();
    await act(async () => {
      answer(SHOP_FIELDS);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The old refusal is not put back beside 'Saved.'.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Saved.')).toBeVisible();
  });

  it('[WF-006] names a custom field a transition asks for by its name from the catalogue (T-297)', async () => {
    const user = userEvent.setup();
    const asking: typeof TRANSITIONS = [
      ...TRANSITIONS,
      {
        id: 6,
        name: 'Plan',
        to: { id: 6, name: 'Planned', stage: 'active' },
        layout: ['cf[77]', 'due-date'],
      },
    ];
    renderPage({ transitions: asking });
    await heading();
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'Planned' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This transition asks for Customer tier, Due date, which this page cannot fill in yet.',
      ),
    );
  });

  it('[CORE-008][WF-006] names a refused transition value, and fields a transition asks for, by their labels in Spanish (T-292)', async () => {
    const user = userEvent.setup();
    const asking: typeof TRANSITIONS = [
      ...TRANSITIONS,
      {
        id: 6,
        name: 'Plan',
        to: { id: 6, name: 'Planned', stage: 'active' },
        layout: ['target-release', 'due-date'],
      },
    ];
    const { client } = renderPage({ transitions: asking }, 'es');
    await heading();
    await within(screen.getByRole('region', { name: 'Detalles' })).findByRole('spinbutton', {
      name: 'Puntos',
    });
    client.transition = async () => {
      throw new ApiError(400, {
        error: 'invalid_fields',
        fields: { 'close-reason': 'not_found', 'fields.31': 'required' },
      });
    };
    await user.click(await screen.findByRole('button', { name: /^Estado: / }));
    await user.click(screen.getByRole('menuitem', { name: 'Closed' }));
    const form = await screen.findByRole('form', { name: /Close/ });
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Close' })).toBeEnabled());
    await user.click(within(form).getByRole('button', { name: 'Close' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Revisa estos valores. Motivo de cierre: Esta opción no está disponible. ' +
        'Puntos: Este campo es obligatorio.',
    );
    expect(alert).not.toHaveTextContent('close-reason');
    // A transition that asks for what the page cannot fill in names those fields by label.
    await user.click(screen.getByRole('button', { name: /^Estado: / }));
    await user.click(screen.getByRole('menuitem', { name: 'Planned' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Esta transición pide Versiones objetivo, Fecha límite, que esta página aún no puede rellenar.',
      ),
    );
  });

  it('[WF-006] runs a transition, asking for a close reason when it needs one', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'Closed' }));
    const form = screen.getByRole('form', { name: 'Close: what it needs' });
    expect(within(form).getByRole('combobox', { name: 'Close reason' })).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Moved to Closed.')).toBeInTheDocument();
    expect(within(details()).getByText('Closed · Done')).toBeVisible();
    expect(client.calls.find((c) => c.action === 'transition')?.args).toEqual([
      41,
      4,
      { 'close-reason': 1 },
    ]);
  });

  it('[CORE-022] shows history, time entries and everything in one stream, and logs time', async () => {
    const user = userEvent.setup();
    renderPage();
    await heading();
    const tabs = screen.getByRole('tablist', { name: 'Activity' });
    await user.click(within(tabs).getByRole('tab', { name: 'History' }));
    const panel = screen.getByRole('tabpanel', { name: 'History' });
    expect(await within(panel).findByText('Changed Status from New to Active')).toBeVisible();
    expect(within(panel).getByText('Set Priority to High')).toBeVisible();
    // Arrow keys move between tabs.
    await user.keyboard('{ArrowRight}');
    expect(within(tabs).getByRole('tab', { name: 'Time entries' })).toHaveFocus();
    const time = screen.getByRole('tabpanel', { name: 'Time entries' });
    expect(await within(time).findByText('2 h · Reproduced and traced')).toBeVisible();
    await user.type(within(time).getByRole('textbox', { name: 'Time spent' }), '1.5');
    await user.type(within(time).getByRole('textbox', { name: 'What was done (optional)' }), 'Fix');
    await user.click(within(time).getByRole('button', { name: 'Log time' }));
    expect(await within(time).findByText('1.5 h · Fix')).toBeVisible();
    await user.click(within(tabs).getByRole('tab', { name: 'All' }));
    const all = screen.getByRole('tabpanel', { name: 'All' });
    expect(await within(all).findByText('Changed Status from New to Active')).toBeVisible();
    expect(within(all).getAllByText('Commented').length).toBeGreaterThan(0);
    expect(within(all).getByText('Logged 2 h')).toBeVisible();
  });

  // History reads a start or due day as the ticket's own fields do, in the reader's locale and
  // on its calendar day, never 'Set Due date to 2026-10-13' (T-240).
  it.each([
    {
      locale: 'en' as const,
      names: ['Activity', 'History'],
      lines: ['Changed Due date from Oct 13, 2026 to Nov 2, 2026', 'Set Start date to Oct 1, 2026'],
    },
    {
      locale: 'es' as const,
      names: ['Actividad', 'Historial'],
      lines: [
        'Cambió Fecha límite de 13 oct 2026 a 2 nov 2026',
        'Definió Fecha de inicio como 1 oct 2026',
      ],
    },
  ])(
    '[CORE-022] [NFR-006] reads start and due days in history in $locale',
    async ({ locale, names, lines }) => {
      const user = userEvent.setup();
      const { client } = renderPage({}, locale);
      const day = (field: string, from: string | null, to: string) => ({
        id: field,
        at: '2026-10-21T15:00:00Z',
        actor: null,
        field,
        from: { value: from, display: null },
        to: { value: to, display: null },
        transitionId: null,
      });
      vi.spyOn(client, 'history').mockResolvedValue({
        changes: [day('dueDate', '2026-10-13', '2026-11-02'), day('startDate', null, '2026-10-01')],
        next: null,
      });
      await heading();
      const [activity, history] = names as [string, string];
      const tabs = screen.getByRole('tablist', { name: activity });
      await user.click(within(tabs).getByRole('tab', { name: history }));
      const panel = screen.getByRole('tabpanel', { name: history });
      for (const line of lines) expect(await within(panel).findByText(line)).toBeVisible();
    },
  );

  // A custom date or date-and-time field's change reads as the ticket's own dates do, by the
  // field's name, never 'Set a custom field to 2026-10-13T09:00:00.000Z' (T-277). A moment is
  // on the reader's clock: 09:00 in UTC is 4:00 in the morning in Chicago.
  describe('custom dates in history (T-277)', () => {
    useTimeZone('America/Chicago');

    it.each([
      {
        locale: 'en' as const,
        names: ['Activity', 'History'],
        lines: [
          'Changed Go-live day from Oct 13, 2026 to Nov 2, 2026',
          'Set Cut-over to Oct 13, 2026, 4:00 AM',
          'Set a custom field to Dec 1, 2026',
          'Set Rollout note to 2026-10-13',
        ],
      },
      {
        locale: 'es' as const,
        names: ['Actividad', 'Historial'],
        lines: [
          'Cambió Go-live day de 13 oct 2026 a 2 nov 2026',
          'Definió Cut-over como 13 oct 2026, 4:00',
          'Definió un campo personalizado como 1 dic 2026',
          'Definió Rollout note como 2026-10-13',
        ],
      },
    ])(
      '[CORE-022] [NFR-006] reads custom date and date-and-time fields by name in $locale',
      async ({ locale, names, lines }) => {
        const user = userEvent.setup();
        const { client } = renderPage({}, locale);
        const row = (
          field: string,
          fieldName: string | null,
          valueType: 'date' | 'datetime' | null,
          from: string | null,
          to: string,
        ) => ({
          id: field,
          at: '2026-10-21T15:00:00Z',
          actor: null,
          field,
          fieldName,
          valueType,
          from: { value: from, display: null },
          to: { value: to, display: null },
          transitionId: null,
        });
        vi.spyOn(client, 'history').mockResolvedValue({
          changes: [
            row('cf[50]', 'Go-live day', 'date', '2026-10-13', '2026-11-02'),
            row('cf[51]', 'Cut-over', 'datetime', null, '2026-10-13T09:00:00.000Z'),
            // A field that no longer applies to the ticket has no name for the reader.
            row('cf[52]', null, 'date', null, '2026-12-01'),
            // Text that looks like a day stays as written.
            row('cf[53]', 'Rollout note', null, null, '2026-10-13'),
          ],
          next: null,
        });
        await heading();
        const [activity, history] = names as [string, string];
        const tabs = screen.getByRole('tablist', { name: activity });
        await user.click(within(tabs).getByRole('tab', { name: history }));
        const panel = screen.getByRole('tabpanel', { name: history });
        for (const line of lines) expect(await within(panel).findByText(line)).toBeVisible();
      },
    );
  });

  it('[AGL-018] keyboard shortcuts: help, follow, assign, comment, edit, transitions', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await screen.findByRole('button', { name: 'Follow (2)' });
    await user.keyboard('?');
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Write a comment')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toHaveFocus();

    await user.keyboard('w');
    expect(await screen.findByRole('button', { name: 'Follow (3)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.keyboard('a');
    expect(await within(details()).findByText('Ada Lovelace', { selector: 'span' })).toBeVisible();
    expect(client.calls.find((c) => c.action === 'edit')?.args[1]).toEqual({ assigneeId: 1 });
    await user.keyboard('t');
    expect(screen.getByRole('button', { name: /^Status: / })).toHaveFocus();
    await user.keyboard('{Escape}');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('m');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement?.closest('.comment-composer')).not.toBeNull();
    // Typing in a field is typing, not a shortcut.
    await user.keyboard('w');
    expect(screen.getByRole('button', { name: 'Follow (3)' })).toBeVisible();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('e');
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveFocus();
  });

  it('[AGL-018] copies the ticket’s full address, and says so in words', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#/tickets/SHOP-41`);
    expect(await screen.findByText('The link to SHOP-41 is copied.')).toBeVisible();
  });

  it('[AGL-018] shows the link to copy by hand when the clipboard is refused', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(
      await screen.findByText(
        `The browser did not allow copying. The link is ${window.location.origin}/#/tickets/SHOP-41`,
      ),
    ).toBeVisible();
  });

  it("[AGL-007] sets Points in place, in the person's language; someone who may not edit reads it", async () => {
    const user = userEvent.setup();
    const { client } = renderPage({}, 'es');
    const points = await screen.findByRole('spinbutton', { name: 'Puntos' });
    await user.type(points, '5');
    await user.keyboard('{Enter}');
    const edits = () => client.calls.filter((c) => c.action === 'edit').map((c) => c.args[1]);
    await vi.waitFor(() => expect(edits()).toEqual([{ fields: { 31: 5 } }]));
    await vi.waitFor(() => expect(points).toHaveValue(5));
    await user.clear(points);
    await user.tab();
    await vi.waitFor(() => expect(edits().at(-1)).toEqual({ fields: { 31: null } }));
    cleanup();
    renderPage({ ticket: { ...SHOP_41, mayEdit: false, fields: { 31: 8 } } });
    expect(await screen.findByText('Points')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Points' })).toBeNull();
  });

  it('[CORE-014] sets the priority with icon and name; someone who may not edit sees the value', async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    const picker = await within(await screen.findByRole('region', { name: 'Details' })).findByRole(
      'combobox',
      { name: 'Priority' },
    );
    await user.click(picker);
    const option = await screen.findByRole('option', { name: /Highest/ });
    expect(option.querySelector('svg')).not.toBeNull();
    await user.click(option);
    expect(client.calls.some((c) => c.action === 'edit')).toBe(true);
    cleanup();

    renderPage({ ticket: { ...SHOP_41, mayEdit: false } });
    const facts = await screen.findByRole('region', { name: 'Details' });
    expect(within(facts).queryByRole('combobox', { name: 'Priority' })).toBeNull();
    expect(within(facts).getByText('High')).toBeVisible();
  });

  it('[CORE-023] opens the clone dialog from the Clone action, and Escape closes it', async () => {
    const user = userEvent.setup();
    renderPage();
    await heading();
    await user.click(await screen.findByRole('button', { name: 'Clone' }));
    const box = await screen.findByRole('dialog', { name: 'Clone SHOP-41' });
    expect(within(box).getByLabelText('Summary of the copy')).toHaveValue(
      'Checkout fails for expired cards',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Clone SHOP-41' })).toBeNull();
  });

  it('says so when the ticket is not there', async () => {
    renderPage({ missing: true });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is no such ticket, or you cannot see it.',
    );
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    await heading();
    expect(screen.getByRole('region', { name: 'Details' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Follow (2)' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage({}, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    await within(main).findAllByRole('button', { expanded: false });
    // The ticket's own values, people and what they wrote are data.
    const ticket: TicketDetails = SHOP_41;
    const data = new Set<string>([
      ticket.summary,
      `${ticket.key} ${ticket.summary}`,
      `${ticket.track.name} · ${messagesFor('en-XA')['ticketType.name.bug']}`,
      ticket.status.name,
      ...['Grace Hopper', 'Ada Lovelace', 'High', 'Highest', 'Medium', '2.4', 'Payments'],
      'payments, checkout',
      'SHOP-40 Card payments',
      'SHOP-40',
      'Card payments',
      'SHOP-39',
      'Card validation service',
      'is blocked by',
      'Send to review',
      'Close',
      // The info panel's participants and statuses (M1-125).
      'Ada Lovelace and Grace Hopper',
      'To do',
      'In progress',
      'In review',
    ]);
    for (const element of main.querySelectorAll(
      '.comment-body, .comment-author, .comment-date, .rt-content, .attachment-name, .attachment-meta, option[value*=":"], .ticket-feed-date',
    )) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        data.add((node.textContent ?? '').trim());
      }
    }
    const texts = visibleTexts(main).filter(
      (t) =>
        !data.has(t) &&
        !/^[\d,.+]+$/.test(t) &&
        !/\p{Extended_Pictographic}/u.test(t) &&
        !/\d{4}|\d:\d\d/.test(t),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('what the ticket offers the editors in it (NTF-014)', () => {
  it('[NTF-014] asks for the files again after a read that failed, rather than keeping the failure', async () => {
    const files = fakeAttachmentClient();
    let down = true;
    const list = vi.fn(() => (down ? Promise.reject(new Error('Bad gateway')) : files.list()));
    const tools = ticketEditorTools({ ...files, list }, { pick: async () => [] });
    await expect(tools.attachments?.()).rejects.toThrow('Bad gateway');
    down = false;
    const found = await tools.attachments?.();
    expect(found?.map((file) => file.name)).toContain('checkout-error.png');
    // A good answer is kept for the page: only the menu's own fresh read asks again.
    await tools.attachments?.();
    expect(list).toHaveBeenCalledTimes(2);
    await tools.attachments?.(true);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('controls follow what the reader may change (T-191)', () => {
  it.each([
    ['desktop', 1440],
    ['phone', 375],
  ])(
    '[IAM-010] [WF-007] a member who may change only some fields sees controls only there (%s)',
    async (_name, width) => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { client } = renderPage({ ticket: SHOP_41_SOME_FIELDS });
      await heading();
      const facts = details();
      // Offered: labels, the due date and Points.
      expect(within(facts).getByRole('button', { name: 'Edit labels' })).toBeVisible();
      expect(within(facts).getByLabelText('Due date')).toHaveValue('2026-11-02');
      expect(await within(facts).findByRole('spinbutton', { name: 'Points' })).toBeVisible();
      // Read only: the summary, the assignee, the priority and the start date show their values.
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull();
      expect(within(facts).queryByRole('button', { name: 'Assign to me' })).toBeNull();
      expect(within(facts).queryByRole('button', { name: 'Unassign' })).toBeNull();
      expect(within(facts).getByText('Grace Hopper')).toBeVisible();
      expect(within(facts).queryByRole('combobox', { name: 'Priority' })).toBeNull();
      expect(within(facts).getByText('High')).toBeVisible();
      expect(within(facts).queryByLabelText('Start date')).toBeNull();
      expect(within(facts).getByText('Oct 20, 2026')).toBeVisible();
      // Nor do their keys: E and A change nothing.
      await user.keyboard('e');
      await user.keyboard('a');
      expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull();
      // What is offered works.
      await user.click(within(facts).getByRole('button', { name: 'Edit labels' }));
      await user.type(within(facts).getByRole('textbox', { name: 'Labels' }), ' urgent');
      await user.click(within(facts).getByRole('button', { name: 'Save' }));
      await vi.waitFor(() =>
        expect(client.calls.filter((c) => c.action === 'edit').map((c) => c.args[1])).toEqual([
          { labels: ['payments', 'checkout', 'urgent'] },
        ]),
      );
      // The answer to the edit says the same as reading did, and the page follows it.
      expect(await within(facts).findByText('payments, checkout, urgent')).toBeVisible();
      expect(within(facts).getByRole('button', { name: 'Edit labels' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull();
    },
  );

  /** Reading the ticket, in the calls the page made. */
  const reads = (client: FakeTicketClient) => client.calls.filter((c) => c.action === 'get');

  it('[IAM-010] an edit that changes who may edit takes what its answer says, at once', async () => {
    const user = userEvent.setup();
    // A ticket-level grant: its assignee may edit it; any member may take it or drop it.
    const { client } = renderPage({
      access: (ticket): TicketAccess =>
        ticket.assignee?.id === ADA_SESSION_ID
          ? { mayEdit: true, editableFields: ['summary', 'assignee', 'labels', 'dueDate'] }
          : { mayEdit: false, editableFields: ['assignee'] },
    });
    await heading();
    expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull();
    expect(within(details()).queryByRole('button', { name: 'Edit labels' })).toBeNull();
    // Ada takes it: the answer to the edit says she may change it now.
    await user.click(within(details()).getByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByRole('button', { name: 'Edit summary' })).toBeVisible();
    expect(within(details()).getByRole('button', { name: 'Edit labels' })).toBeVisible();
    expect(within(details()).getByLabelText('Due date')).toBeVisible();
    // She drops it: the controls go with the answer, with nothing kept from before.
    await user.click(within(details()).getByRole('button', { name: 'Unassign' }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull(),
    );
    expect(within(details()).queryByRole('button', { name: 'Edit labels' })).toBeNull();
    expect(within(details()).queryByLabelText('Due date')).toBeNull();
    expect(reads(client)).toHaveLength(1);
  });

  it('[WF-007] a transition into a locked status takes what may change from its answer', async () => {
    const user = userEvent.setup();
    const { client } = renderPage({
      access: (ticket): TicketAccess => ({
        mayEdit: true,
        editableFields: ticket.status.name === 'In review' ? [] : ['summary', 'labels'],
      }),
    });
    expect(await screen.findByRole('button', { name: 'Edit summary' })).toBeVisible();
    // In review, the ticket is locked: the transition's answer says so, and nothing is read again.
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    await user.click(screen.getByRole('menuitem', { name: 'In review' }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Edit summary' })).toBeNull(),
    );
    expect(within(details()).queryByRole('button', { name: 'Edit labels' })).toBeNull();
    expect(reads(client)).toHaveLength(1);
  });
});

describe('unsaved text on the full page (T-190)', () => {
  let stop = () => {};
  beforeEach(() => {
    window.history.replaceState(null, '', '/#/tracks/SHOP/board');
    window.history.pushState(null, '', '/#/tickets/SHOP-41');
    stop = router.start();
  });
  afterEach(() => {
    stop();
    cleanup();
  });

  const NAV = (
    <nav>
      <a href="#/boards">Boards</a>
    </nav>
  );
  const asked = () =>
    screen.findByRole('alertdialog', { name: 'Discard what you have not saved?' });
  /** Types labels on the page and leaves them unsaved. */
  async function typeLabels() {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV);
    await heading();
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    await user.type(labels, ' typed');
    return { user, labels };
  }
  /** Whether closing or reloading the tab would make the browser ask. */
  const unloadAsks = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('[NFR-005] a link inside the app asks first; keeping loses nothing and discarding leaves', async () => {
    const { user, labels } = await typeLabels();
    await user.click(screen.getByRole('link', { name: 'Boards' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels).toHaveValue('payments checkout typed');
    expect(currentRoute()).toBe('#/tickets/SHOP-41');

    await user.click(screen.getByRole('link', { name: 'Boards' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(currentRoute()).toBe('#/boards'));
  });

  it('[NFR-005] with nothing typed a link leaves at once', async () => {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV);
    await heading();
    // A form opened with nothing changed in it is no draft.
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    await user.click(screen.getByRole('link', { name: 'Boards' }));
    await waitFor(() => expect(currentRoute()).toBe('#/boards'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[NFR-005] a ticket opened over the page does not leave it, and Back from it does not ask', async () => {
    const { user, labels } = await typeLabels();
    await user.click(within(details()).getByRole('link', { name: 'SHOP-40 Card payments' }));
    expect(overlayRoute()).toBe('#/tickets/SHOP-40');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    window.history.back();
    await waitFor(() => expect(addressRoute()).toBe('#/tickets/SHOP-41'));
    expect(overlayRoute()).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(labels).toHaveValue('payments checkout typed');
  });

  it('[NFR-005] Back with a draft comes back at once and asks; discarding goes back', async () => {
    const { user, labels } = await typeLabels();
    window.history.back();
    await asked();
    await waitFor(() => expect(addressRoute()).toBe('#/tickets/SHOP-41'));
    expect(labels).toHaveValue('payments checkout typed');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(labels).toHaveValue('payments checkout typed');

    window.history.back();
    await user.click(within(await asked()).getByRole('button', { name: 'Discard it' }));
    await waitFor(() => expect(addressRoute()).toBe('#/tracks/SHOP/board'));
  });

  it('[NFR-005] [CORE-032] Add and open leaves for the new subticket at once: its summary is saved', async () => {
    const user = userEvent.setup();
    const tools = fakeToolsClient();
    tools.createChild = async () => ({ id: 400, key: 'SHOP-400' });
    renderPage({}, 'en', NAV, tools);
    await heading();
    const subs = await screen.findByRole('region', { name: 'Subtickets' });
    await user.type(within(subs).getByRole('textbox', { name: 'New subticket' }), 'Write tests');
    await user.click(within(subs).getByRole('button', { name: 'Add and open' }));
    await waitFor(() => expect(currentRoute()).toBe('#/tickets/SHOP-400'));
    expect(addressRoute()).toBe('#/tickets/SHOP-400');
    expect(overlayRoute()).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[NFR-005] [CORE-032] Add and open with another draft open asks; staying shows the new subticket', async () => {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV, fakeToolsClient());
    await heading();
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    await user.type(labels, ' typed');
    const subs = await screen.findByRole('region', { name: 'Subtickets' });
    await user.type(
      await within(subs).findByRole('textbox', { name: 'New subticket' }),
      'Write tests',
    );
    await user.click(within(subs).getByRole('button', { name: 'Add and open' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Keep editing' }));
    expect(currentRoute()).toBe('#/tickets/SHOP-41');
    expect(labels).toHaveValue('payments checkout typed');
    expect(await within(subs).findByText('Write tests')).toBeVisible();
    expect(within(subs).getByText(/was added\./)).toBeVisible();
  });

  it('[NFR-005] closing or reloading the tab asks only while there is a draft', async () => {
    const user = userEvent.setup();
    renderPage({}, 'en', NAV);
    await heading();
    expect(unloadAsks()).toBe(false);
    await user.click(within(details()).getByRole('button', { name: 'Edit labels' }));
    const labels = within(details()).getByRole('textbox', { name: 'Labels' });
    expect(unloadAsks()).toBe(false);
    await user.type(labels, ' typed');
    expect(unloadAsks()).toBe(true);
    await user.click(within(details()).getByRole('button', { name: 'Save' }));
    await within(details()).findByText('payments, checkout, typed');
    expect(unloadAsks()).toBe(false);
  });
});

describe('the ticket view after the page review (T-220)', () => {
  const follows = (first: Element, second: Element) =>
    Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('[CORE-022] [NFR-005] shows Details before Activity on a phone (PL-25, D33)', async () => {
    setViewportWidth(375);
    renderPage();
    await heading();
    const activity = await screen.findByRole('region', { name: 'Activity' });
    expect(follows(details(), activity)).toBe(true);
    // The help says where they are on this screen, not "on the side" (PL-48).
    await userEvent.setup().click(screen.getByRole('button', { name: 'What is SHOP-41 for?' }));
    expect(screen.getByText(/^The buttons under the title/)).toHaveTextContent(
      'Details, after the description',
    );
  });

  it('[CORE-022] places Details by the same rem as the stylesheet, so a larger text size keeps them in the flow (PL-48)', async () => {
    // 1100px is wider than 64rem at 16px (1024px) but narrower at 20px (1280px): the columns
    // of ticket-view.css stack, and the help must say Details come after the description.
    setRootFontSize(20);
    setViewportWidth(1100);
    renderPage();
    await heading();
    await userEvent.setup().click(screen.getByRole('button', { name: 'What is SHOP-41 for?' }));
    expect(screen.getByText(/^The buttons under the title/)).toHaveTextContent(
      'Details, after the description',
    );
  });

  it('[CORE-022] keeps the help mark beside the title and says Details stand at the side on a wide screen (PL-44, PL-48)', async () => {
    setViewportWidth(1440);
    renderPage();
    const title = await heading();
    const help = screen.getByRole('button', { name: 'What is SHOP-41 for?' });
    // In the title's own line, which never lets it wrap away from the title.
    expect(help.closest('.ticket-title-line')).toBe(title.parentElement);
    await userEvent.setup().click(help);
    expect(screen.getByText(/^The buttons under the title/)).toHaveTextContent(
      'Details on the side',
    );
  });

  it('[AGL-007] shows an empty Points as None, as other empty fields (PL-44)', async () => {
    renderPage({ ticket: SHOP_41_SOME_FIELDS });
    await heading();
    const points = await within(details()).findByRole('spinbutton', { name: 'Points' });
    expect(points).toHaveValue(null);
    expect(points).toHaveAttribute('placeholder', 'None');
  });

  it('[WF-006] heads the status menu with the current status, marked, outside its items (PL-47)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^Status: / }));
    const menu = screen.getByRole('menu');
    const now = screen.getByText(`Now: ${SHOP_41.status.name}`);
    expect(now).toBeVisible();
    expect(menu.contains(now)).toBe(false);
    expect(follows(now, menu)).toBe(true);
  });

  it('[CORE-022] prints only the ticket: no top bar, sidebar, toolbars, comment box or buttons (PL-27, D37)', async () => {
    const gone = applyStylesheet('print.css', 'print');
    try {
      renderPage();
      await heading();
      const hidden = (element: Element | null) =>
        element !== null && getComputedStyle(element).display === 'none';
      const page = document.querySelector('.ticket-page') as HTMLElement;
      for (const selector of ['.ticket-toolbar', '.help-tip', '.ticket-tabs', '.ticket-tool']) {
        expect(page.querySelector(selector), selector).not.toBeNull();
        expect(hidden(page.querySelector(selector)), selector).toBe(true);
      }
      // What a reader wants stays: the title, the description and the fields.
      expect(hidden(await heading())).toBe(false);
      expect(hidden(details())).toBe(false);
      expect(hidden(page.querySelector('.ticket-text'))).toBe(false);
      // Priority prints its value as text: its menu's button stays, without its chevron.
      const priority = within(details()).getByRole('combobox', { name: 'Priority' });
      expect(hidden(priority)).toBe(false);
      expect(priority).toHaveTextContent('High');
      expect(hidden(priority.querySelector('svg:last-child'))).toBe(true);
      // Other buttons in the details still go.
      const other = details().querySelector('button:not(.icon-select-button)');
      expect(other).not.toBeNull();
      expect(hidden(other)).toBe(true);
    } finally {
      gone();
    }
  });

  it('[NFR-005] gives a short tab a finger’s room (PL-26)', async () => {
    const gone = applyStylesheet('ticket-view.css', 'pointer: coarse');
    try {
      renderPage();
      await heading();
      const all = await screen.findByRole('tab', { name: 'All' });
      expect(getComputedStyle(all).minWidth).toBe('var(--hit-target-touch)');
      expect(getComputedStyle(all).minHeight).toBe('var(--hit-target-touch)');
    } finally {
      gone();
    }
  });
});

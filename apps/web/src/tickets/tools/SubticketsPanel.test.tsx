import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import type { SearchClient } from '../../search/client';
import { ResultTable } from '../../search/ResultTable';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { fakeToolsClient } from './fixtures';
import { percentOf, SubticketProgressMini } from './Progress';
import { SubticketsPanel } from './SubticketsPanel';

const ticket = (rank: number) => ({
  id: 41,
  key: 'SHOP-41',
  track: { key: 'SHOP' },
  ticketType: { level: { rank } },
});

function renderPanel(client = fakeToolsClient(), rank = 0, locale: Locale = 'en') {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SubticketsPanel ticket={ticket(rank)} client={client} revision={0} />
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}

describe('the percentage (CORE-032)', () => {
  it('[CORE-032] rounds to a whole percent, and nothing to count reads 0', () => {
    expect(percentOf(1, 2)).toBe(50);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 0)).toBe(0);
  });
});

describe('SubticketsPanel', () => {
  it('[CORE-032] lists them with their status and the progress in numbers', async () => {
    renderPanel();
    const panel = await screen.findByRole('region', { name: 'Subtickets' });
    expect(await within(panel).findByRole('link', { name: 'SHOP-201' })).toBeVisible();
    expect(within(panel).getByText('Done')).toBeVisible();
    expect(within(panel).getByText('In progress')).toBeVisible();
    expect(await within(panel).findByText('1 of 2 closed (50%)')).toBeVisible();
    const bar = within(panel).getByRole('progressbar', { name: '1 of 2 closed (50%)' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('[CORE-032] adds one from a summary and stays, by keyboard', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    const field = await screen.findByRole('textbox', { name: 'New subticket' });
    await user.type(field, 'Check the receipt{Enter}');
    await waitFor(() => expect(screen.getByText('Check the receipt')).toBeVisible());
    expect(client.calls).toContainEqual({
      action: 'createChild',
      args: [{ track: 'SHOP', parent: 'SHOP-41', ticketTypeId: 9, summary: 'Check the receipt' }],
    });
    expect(field).toHaveValue('');
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByText('1 of 3 closed (33%)')).toBeVisible();
  });

  it('[CORE-032] says what the track also asks for when it refuses', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient();
    client.createChild = async () => {
      throw new ApiError(400, { error: 'invalid_fields', fields: { dueDate: 'required' } });
    };
    renderPanel(client);
    await user.type(
      await screen.findByRole('textbox', { name: 'New subticket' }),
      'Needs more{Enter}',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This track also asks for: dueDate. Use the create form for this one.',
    );
    expect(screen.getByRole('textbox', { name: 'New subticket' })).toHaveValue('Needs more');
  });

  it('[CORE-032] asks which type when the track has several', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel(
      fakeToolsClient({
        childTypes: [
          { id: 9, name: 'Subticket' },
          { id: 10, name: 'Sub-bug' },
        ],
      }),
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Ticket type' }),
      'Sub-bug',
    );
    await user.type(screen.getByRole('textbox', { name: 'New subticket' }), 'A{Enter}');
    await waitFor(() =>
      expect(client.calls).toContainEqual({
        action: 'createChild',
        args: [{ track: 'SHOP', parent: 'SHOP-41', ticketTypeId: 10, summary: 'A' }],
      }),
    );
  });

  it('[CORE-032] shows nothing on a subticket: it has none of its own', async () => {
    const { client, container } = renderPanel(fakeToolsClient(), -1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('section')).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('[CORE-032] names the section differently above the standard level', async () => {
    renderPanel(fakeToolsClient(), 1);
    expect(await screen.findByRole('region', { name: 'Tickets under this' })).toBeVisible();
  });

  it('[CORE-032] says when there are none, with no progress', async () => {
    renderPanel(fakeToolsClient({ children: [] }));
    expect(await screen.findByText('None yet.')).toBeVisible();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('[CORE-032] works on a phone', async () => {
    setViewportWidth(360);
    renderPanel();
    expect(await screen.findByRole('textbox', { name: 'New subticket' })).toBeVisible();
  });

  it('[NFR-006] comes from the catalogue, in the pseudo-locale too', async () => {
    const { errors, container } = renderPanel(undefined, 0, 'en-XA');
    await screen.findByRole('link', { name: 'SHOP-201' });
    await screen.findByRole('progressbar');
    expect(errors).toEqual([]);
    const texts = visibleTexts(container).filter(
      (text) => !/SHOP|retry|slow network|^Done$|In progress/i.test(text),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});

describe('SubticketProgressMini', () => {
  it('[CORE-032] reads the numbers aloud and shows them short', () => {
    render(
      <I18nProvider locale="en">
        <SubticketProgressMini progress={{ total: 4, closed: 1 }} />
      </I18nProvider>,
    );
    expect(screen.getByText('1 of 4 closed (25%)')).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeVisible();
  });
});

describe('the result table (CORE-032)', () => {
  it('[CORE-032] shows the same small progress under the key of a ticket that has subtickets', async () => {
    const client = {
      priorities: async () => [],
      subticketProgress: async () => ({ 7: { total: 2, closed: 2 } }),
    } as unknown as SearchClient;
    const row = (id: number, key: string) => ({
      id,
      key,
      summary: key,
      status: { name: 'New', stage: 'new' as const },
      ticketType: { name: 'Feature' },
      assignee: null,
      updatedAt: '2026-11-03T10:00:00Z',
    });
    render(
      <I18nProvider locale="en">
        <ResultTable
          tickets={[row(7, 'SHOP-7'), row(8, 'SHOP-8')]}
          columns={[]}
          fields={[]}
          client={client}
          onSaved={() => {}}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText('2/2')).toBeVisible();
    expect(screen.getByText('2 of 2 closed (100%)')).toBeInTheDocument();
    expect(screen.getAllByText(/^[0-9]+.[0-9]+$/)).toHaveLength(1);
  });
});

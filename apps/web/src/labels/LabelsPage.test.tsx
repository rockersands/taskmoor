import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type FakeLabelsClient, fakeLabelsClient } from './fixtures';
import { LabelsPage } from './LabelsPage';

function renderPage(
  session: Session = ADMIN,
  {
    locale = 'en',
    client = fakeLabelsClient(),
  }: { locale?: Locale; client?: FakeLabelsClient } = {},
) {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <LabelsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

const listCard = () => screen.getByRole('region', { name: 'Labels on this site' });
const mergeCard = () => screen.getByRole('region', { name: 'Merge or rename' });
/** The labels listed, in order. */
const rows = () =>
  within(within(listCard()).getByRole('list'))
    .getAllByRole('checkbox')
    .map((box) => box.closest('label')?.textContent);
const box = (name: string) => within(listCard()).getByRole('checkbox', { name });

describe('labels: merging and renaming (T-322)', () => {
  it('[CORE-017] lists the labels as suggestions order them, each with how many tickets have it', async () => {
    renderPage();
    await within(listCard()).findByRole('checkbox', { name: 'backend' });
    expect(rows()).toEqual([
      'backend',
      'FE',
      'fe',
      'front-end',
      'frontend',
      'old-sprint',
      'ops',
      'ui',
    ]);
    expect(box('front-end')).toHaveAccessibleDescription('2 tickets');
    expect(box('FE')).toHaveAccessibleDescription('1 ticket');
    // A label no ticket has any more is still suggested, so it is listed.
    expect(box('old-sprint')).toHaveAccessibleDescription('No tickets');
    expect(within(mergeCard()).getByText('No label is ticked yet.')).toBeVisible();
    expect(within(mergeCard()).getByRole('button', { name: 'Merge' })).toBeDisabled();
  });

  it('[CORE-017] finds labels by how they start, whatever their case', async () => {
    const user = userEvent.setup();
    renderPage();
    await within(listCard()).findByRole('checkbox', { name: 'backend' });
    await user.type(within(listCard()).getByLabelText('Find labels that start with'), 'FRO');
    await waitFor(() => expect(rows()).toEqual(['front-end', 'frontend']));
    await user.type(within(listCard()).getByLabelText('Find labels that start with'), 'zz');
    expect(await within(listCard()).findByText('No label starts with FROzz')).toBeVisible();
    expect(
      within(listCard()).getByText('Try fewer letters, or empty the search to see every label.'),
    ).toBeVisible();
  });

  it('[CORE-017] merges the ticked labels into one after asking, on every ticket once', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await within(listCard()).findByRole('checkbox', { name: 'front-end' }));
    await user.click(box('fe'));
    expect(
      within(mergeCard()).getByText('Ticked: front-end (2 tickets) and fe (1 ticket).'),
    ).toBeVisible();
    await user.type(within(mergeCard()).getByLabelText('They become'), 'frontend');
    const merge = within(mergeCard()).getByRole('button', { name: 'Merge' });
    await user.click(merge);

    // Nothing happens before the question is answered (D13); Cancel has the keyboard.
    const question = within(mergeCard()).getByRole('group', {
      name: 'Merge front-end and fe into frontend? The tickets that have them, 3 at most, get frontend in their place, once each, and their history records it. This cannot be undone.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(client.calls.filter((c) => c.action === 'merge')).toEqual([]);
    await user.click(within(question).getByRole('button', { name: 'Merge into frontend' }));

    expect(
      await within(mergeCard()).findByText('front-end and fe became frontend on 3 tickets.'),
    ).toBeVisible();
    expect(client.calls.find((c) => c.action === 'merge')?.args).toEqual([
      ['front-end', 'fe'],
      'frontend',
    ]);
    // Each ticket has the label once, in the place of the first it had.
    expect(client.tickets().slice(0, 4)).toEqual([
      ['frontend', 'ui'],
      ['frontend'],
      ['frontend'],
      ['frontend', 'ops'],
    ]);
    await waitFor(() =>
      expect(rows()).toEqual(['backend', 'FE', 'frontend', 'old-sprint', 'ops', 'ui']),
    );
    expect(box('frontend')).toHaveAccessibleDescription('4 tickets');
    expect(box('frontend')).not.toBeChecked();
    expect(within(mergeCard()).getByText('No label is ticked yet.')).toBeVisible();
    expect(within(mergeCard()).getByLabelText('They become')).toHaveValue('');
    // The keyboard stays on the first step, which waits for the next choice.
    expect(within(mergeCard()).getByRole('button', { name: 'Merge' })).toHaveFocus();
  });

  it('[CORE-017] renames a label: one ticked, and a new word', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await within(listCard()).findByRole('checkbox', { name: 'ui' }));
    await user.type(within(mergeCard()).getByLabelText('They become'), ' user-interface ');
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename' }));
    const question = within(mergeCard()).getByRole('group', {
      name: 'Rename ui to user-interface? Its 2 tickets get user-interface in its place, and their history records it. If user-interface is already a label, the two become one. This cannot be undone.',
    });
    await user.click(within(question).getByRole('button', { name: 'Rename ui to user-interface' }));
    expect(
      await within(mergeCard()).findByText('ui became user-interface on 2 tickets.'),
    ).toBeVisible();
    expect(client.calls.find((c) => c.action === 'merge')?.args).toEqual([
      ['ui'],
      'user-interface',
    ]);
    await waitFor(() => expect(rows().at(-1)).toBe('user-interface'));
    expect(box('user-interface')).toHaveAccessibleDescription('2 tickets');
  });

  it('[CORE-017] merges FE into fe: a label differs by case', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await within(listCard()).findByRole('checkbox', { name: 'FE' }));
    await user.click(box('fe'));
    await user.type(within(mergeCard()).getByLabelText('They become'), 'fe');
    // The label they become stays as it is: only FE changes, so it is a rename.
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename' }));
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename FE to fe' }));
    expect(await within(mergeCard()).findByText('FE became fe on 1 ticket.')).toBeVisible();
    await waitFor(() => expect(box('fe')).toHaveAccessibleDescription('2 tickets'));
  });

  it('[CORE-017] offers the merge only for one word and a label that changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const into = () => within(mergeCard()).getByLabelText('They become');
    await within(listCard()).findByRole('checkbox', { name: 'ops' });
    // Nothing ticked: nothing to merge, whatever is typed.
    await user.type(into(), 'operations');
    expect(within(mergeCard()).getByRole('button', { name: 'Merge' })).toBeDisabled();
    await user.click(box('ops'));
    expect(within(mergeCard()).getByRole('button', { name: 'Rename' })).toBeEnabled();

    await user.clear(into());
    await user.type(into(), 'two words');
    expect(into()).toHaveAttribute('aria-invalid', 'true');
    expect(into()).toHaveAccessibleDescription(
      'A label is one word of up to 255 characters, with no spaces.',
    );
    expect(within(mergeCard()).getByRole('button', { name: 'Rename' })).toBeDisabled();

    await user.clear(into());
    await user.type(into(), 'ops');
    expect(into()).toHaveAccessibleDescription(
      'The ticked labels are already ops: tick another label, or type another word.',
    );
    expect(within(mergeCard()).getByRole('button', { name: 'Merge' })).toBeDisabled();

    await user.clear(into());
    expect(into()).toHaveAccessibleDescription(/^One word, with no spaces\./);
    expect(within(mergeCard()).getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('[CORE-017] keeps the ticks while the search changes, and clears them on request', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await within(listCard()).findByRole('checkbox', { name: 'FE' }));
    await user.type(within(listCard()).getByLabelText('Find labels that start with'), 'fro');
    await waitFor(() => expect(rows()).toEqual(['front-end', 'frontend']));
    await user.click(box('frontend'));
    expect(
      within(mergeCard()).getByText('Ticked: FE (1 ticket) and frontend (2 tickets).'),
    ).toBeVisible();
    await user.click(within(mergeCard()).getByRole('button', { name: 'Clear the ticks' }));
    expect(within(mergeCard()).getByText('No label is ticked yet.')).toBeVisible();
    expect(box('frontend')).not.toBeChecked();
    // The button goes with the ticks: the card's heading takes the keyboard.
    expect(within(mergeCard()).getByRole('heading', { name: 'Merge or rename' })).toHaveFocus();
  });

  it('[CORE-017] reads more labels a page at a time, the keyboard on the first new one', async () => {
    const user = userEvent.setup();
    const client = renderPage(ADMIN, { client: fakeLabelsClient({ many: true }) });
    await within(listCard()).findByRole('checkbox', { name: 'backend' });
    expect(rows()).toHaveLength(50);
    await user.click(within(listCard()).getByRole('button', { name: 'Show more labels' }));
    await waitFor(() => expect(rows()).toHaveLength(68));
    expect(within(listCard()).queryByRole('button', { name: 'Show more labels' })).toBeNull();
    expect(within(listCard()).getAllByRole('checkbox')[50]).toHaveFocus();
    expect(client.calls.filter((c) => c.action === 'usage').at(-1)?.args).toEqual([
      { q: '', after: 'team-43', limit: 50 },
    ]);
  });

  it('[CORE-017] says beside Show more labels when the next labels cannot be read', async () => {
    const user = userEvent.setup();
    const client = fakeLabelsClient({ many: true });
    const usage = client.usage;
    client.usage = async (query) => {
      if (query.after !== undefined) throw new ApiError(500, { error: 'internal' });
      return usage(query);
    };
    renderPage(ADMIN, { client });
    await within(listCard()).findByRole('checkbox', { name: 'backend' });
    await user.click(within(listCard()).getByRole('button', { name: 'Show more labels' }));
    expect(await within(listCard()).findByRole('alert')).toHaveTextContent(
      'More labels could not be read. Try again in a moment.',
    );
    expect(rows()).toHaveLength(50);
    expect(within(listCard()).getByRole('button', { name: 'Show more labels' })).toBeVisible();
  });

  it('[CORE-017] says why a merge was refused, and keeps the question open', async () => {
    const user = userEvent.setup();
    const client = fakeLabelsClient();
    client.merge = async () => {
      throw new ApiError(500, { error: 'internal' });
    };
    renderPage(ADMIN, { client });
    await user.click(await within(listCard()).findByRole('checkbox', { name: 'ops' }));
    await user.type(within(mergeCard()).getByLabelText('They become'), 'operations');
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename' }));
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename ops to operations' }));
    expect(await within(mergeCard()).findByRole('alert')).toHaveTextContent(
      'The labels could not be merged. Try again in a moment.',
    );
    expect(within(mergeCard()).getByRole('group')).toBeVisible();
    expect(box('ops')).toBeChecked();
  });

  it('[CORE-017] words the server’s refusal of the label they become', async () => {
    const user = userEvent.setup();
    const client = fakeLabelsClient();
    client.merge = async () => {
      throw new ApiError(400, { error: 'invalid_request', detail: 'into' });
    };
    renderPage(ADMIN, { client });
    await user.click(await within(listCard()).findByRole('checkbox', { name: 'ops' }));
    await user.type(within(mergeCard()).getByLabelText('They become'), 'operations');
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename' }));
    await user.click(within(mergeCard()).getByRole('button', { name: 'Rename ops to operations' }));
    expect(await within(mergeCard()).findByRole('alert')).toHaveTextContent(
      'A label is one word of up to 255 characters, with no spaces.',
    );
  });

  it('[CORE-017] explains a site with no labels yet', async () => {
    const client = fakeLabelsClient();
    client.usage = async () => ({ labels: [], more: false });
    renderPage(ADMIN, { client });
    expect(await within(listCard()).findByText('No labels yet')).toBeVisible();
  });

  it('says when the labels cannot be read', async () => {
    const client = fakeLabelsClient();
    client.usage = async () => {
      throw new ApiError(500, { error: 'internal' });
    };
    renderPage(ADMIN, { client });
    expect(await within(listCard()).findByRole('alert')).toHaveTextContent(
      'The labels could not be read. Try again in a moment.',
    );
  });

  it('[NFR-005] a configuration administrator merges labels too', async () => {
    renderPage(CONFIG_ADMIN);
    expect(await within(listCard()).findByRole('checkbox', { name: 'frontend' })).toBeVisible();
    expect(within(mergeCard()).getByLabelText('They become')).toBeVisible();
  });

  it('[NFR-005] the server’s refusal of the list leaves only the refusal', async () => {
    const client = fakeLabelsClient();
    client.usage = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    renderPage(ADMIN, { client });
    expect(
      await screen.findByText(
        'Only site and configuration administrators merge and rename labels.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Merge or rename' })).toBeNull();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await within(listCard()).findByRole('checkbox', { name: 'frontend' })).toBeVisible();
  });

  it('[NFR-006] reads in Spanish', async () => {
    renderPage(ADMIN, { locale: 'es' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Etiquetas' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Fusionar o renombrar' })).toBeVisible();
    expect(await screen.findByRole('checkbox', { name: 'frontend' })).toHaveAccessibleDescription(
      '2 tickets',
    );
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const data = new Set([
      'backend',
      'FE',
      'fe',
      'front-end',
      'frontend',
      'old-sprint',
      'ops',
      'ui',
    ]);
    const texts = visibleTexts(main).filter((t) => !data.has(t));
    expect(untranslated(texts)).toEqual([]);
  });
});

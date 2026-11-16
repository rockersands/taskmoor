import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { type ContextLists, ContextsSection } from './ContextsSection';
import type { Field } from './client';
import { type FakeFieldsClient, fakeFieldsClient } from './fixtures';

const LISTS: ContextLists = {
  tracks: [
    { id: 1, key: 'PAY', name: 'Payments' },
    { id: 4, key: 'OPS', name: 'Operations' },
  ],
  types: [
    { id: 11, name: 'Bug' },
    { id: 12, name: 'Feature' },
  ],
  groups: [
    { id: 21, name: 'Reviewers' },
    { id: 22, name: 'Support' },
  ],
  roles: [
    { id: 31, name: 'Administrators' },
    { id: 32, name: 'Members' },
  ],
};

function Harness({ start, client }: { start: Field; client: FakeFieldsClient }) {
  const [field, setField] = useState(start);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState('');
  return (
    <main>
      <ContextsSection
        field={field}
        client={client}
        lists={LISTS}
        onField={setField}
        onChanged={setSaid}
        onProblem={(error) =>
          setProblem(
            error instanceof ApiError ? String((error.body as { error: string }).error) : 'x',
          )
        }
      />
      <p role="status">{said}</p>
      <p data-testid="problem">{problem}</p>
    </main>
  );
}

async function renderField(id: number, prepare?: (client: FakeFieldsClient) => Promise<unknown>) {
  const client = fakeFieldsClient();
  await prepare?.(client);
  client.calls.length = 0;
  const field = await client.field(id);
  render(
    <I18nProvider locale="en">
      <Harness start={field} client={client} />
    </I18nProvider>,
  );
  return client;
}

describe('where a field applies (T-320)', () => {
  it('[CORE-009] shows each context’s reach and changes it to chosen tracks and types', async () => {
    const user = userEvent.setup();
    const client = await renderField(2);
    expect(screen.getByRole('heading', { level: 2, name: 'Where Severity applies' })).toBeVisible();
    const contexts = screen.getAllByRole('heading', { level: 3 });
    expect(contexts.map((h) => h.textContent)).toEqual(['Everywhere', 'Payments bugs']);
    expect(screen.getByText('Every track; every ticket type')).toBeVisible();
    expect(screen.getByText('Tracks: Payments; ticket types: Bug')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Change context Payments bugs' }));
    const form = screen.getByRole('form', { name: 'Change context Payments bugs' });
    const tracks = within(form).getByRole('group', { name: 'Tracks' });
    expect(within(tracks).getByLabelText('Only these tracks')).toBeChecked();
    await user.click(within(tracks).getByLabelText('OPS Operations'));
    const types = within(form).getByRole('group', { name: 'Ticket types' });
    await user.click(within(types).getByLabelText('Feature'));
    await user.click(within(form).getByRole('button', { name: 'Save the context' }));
    expect(await screen.findByText('The context Payments bugs was saved.')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({
      action: 'updateContext',
      args: [2, 21, { name: 'Payments bugs', trackIds: [1, 4], ticketTypeIds: [11, 12] }],
    });
    expect(
      screen.getByText('Tracks: Payments, Operations; ticket types: Bug, Feature'),
    ).toBeVisible();
  });

  it('[CORE-009] asks for a track before saving one with none ticked, and refuses an overlap', async () => {
    const user = userEvent.setup();
    const client = await renderField(2);
    await user.click(screen.getByRole('button', { name: 'New context' }));
    const form = screen.getByRole('form', { name: 'Add a context' });
    await user.type(within(form).getByLabelText('Context name'), 'Ops');
    await user.click(within(form).getByLabelText('Only these tracks'));
    await user.click(within(form).getByRole('button', { name: 'Add a context' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Tick at least one track, or choose Every track.',
    );
    expect(client.calls).toEqual([]);
    // Every track and type would meet the context for all.
    await user.click(within(form).getByLabelText('Every track'));
    await user.click(within(form).getByRole('button', { name: 'Add a context' }));
    expect(await screen.findByTestId('problem')).toHaveTextContent('context_overlap');
    await user.click(within(form).getByLabelText('Only these tracks'));
    await user.click(within(form).getByLabelText('OPS Operations'));
    await user.click(within(form).getByRole('button', { name: 'Add a context' }));
    expect(await screen.findByText('The context Ops was added.')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({
      action: 'addContext',
      args: [2, { name: 'Ops', trackIds: [4], ticketTypeIds: null }],
    });
  });

  it('[CORE-009] deletes a context, saying the last one leaves the field nowhere', async () => {
    const user = userEvent.setup();
    const client = await renderField(1);
    await user.click(screen.getByRole('button', { name: 'Delete context Everywhere' }));
    const question = screen.getByRole('group', {
      name: /^Delete Everywhere\? It is the field’s last context, so the field will apply nowhere/,
    });
    await user.click(within(question).getByRole('button', { name: 'Delete context Everywhere' }));
    expect(await screen.findByText('This field applies nowhere.')).toBeVisible();
    expect(client.calls.map((c) => c.action)).toEqual(['deleteContext']);
  });

  it('[CORE-009] limits a person field to a group’s members, then to a role, then to anyone', async () => {
    const user = userEvent.setup();
    const client = await renderField(6);
    expect(screen.getByText('People to choose from: the members of Reviewers')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change context Everywhere' }));
    let form = screen.getByRole('form', { name: 'Change context Everywhere' });
    await user.selectOptions(within(form).getByLabelText('Offer'), 'role');
    await user.selectOptions(within(form).getByLabelText('Track role'), '31');
    await user.click(within(form).getByRole('button', { name: 'Save the context' }));
    expect(
      await screen.findByText(
        'People to choose from: whoever holds Administrators in the ticket’s track',
      ),
    ).toBeVisible();
    // A null clears the limit not chosen.
    expect(client.calls.at(-1)?.args[2]).toEqual({
      name: 'Everywhere',
      trackIds: null,
      ticketTypeIds: null,
      config: { userGroupId: null, userRoleId: 31 },
    });
    await user.click(screen.getByRole('button', { name: 'Change context Everywhere' }));
    form = screen.getByRole('form', { name: 'Change context Everywhere' });
    await user.selectOptions(within(form).getByLabelText('Offer'), 'anyone');
    await user.click(within(form).getByRole('button', { name: 'Save the context' }));
    expect(await screen.findByText('People to choose from: anyone')).toBeVisible();
  });

  it('[CORE-009] sets a choice list’s default and removes it', async () => {
    const user = userEvent.setup();
    const client = await renderField(2);
    const form = screen.getByRole('form', { name: 'Default value in Everywhere' });
    expect(within(form).getByLabelText('Default value')).toHaveValue('201');
    // The default is marked in the list; an option no longer offered is not offered as one.
    const options = screen.getAllByRole('heading', { name: 'Options in Everywhere' })[0]
      ?.parentElement as HTMLElement;
    expect(within(options).getByText('Default')).toBeVisible();
    expect(
      within(within(form).getByLabelText('Default value')).queryByRole('option', {
        name: 'Critical',
      }),
    ).toBeNull();
    await user.selectOptions(within(form).getByLabelText('Default value'), '202');
    await user.click(within(form).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Everywhere was saved.')).toBeVisible();
    expect(client.calls.at(-1)).toEqual({
      action: 'updateContext',
      args: [2, 20, { defaultValue: 202 }],
    });
    await user.click(within(form).getByRole('button', { name: 'Remove the default' }));
    expect(await screen.findByText('Everywhere has no default now.')).toBeVisible();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: null });
    expect(within(form).getByLabelText('Default value')).toHaveValue('');
  });

  it('[CORE-009] gives a two-level list a default option and child', async () => {
    const user = userEvent.setup();
    const client = await renderField(5);
    const form = screen.getByRole('form', { name: 'Default value in Everywhere' });
    await user.selectOptions(within(form).getByLabelText('Default value'), '501');
    await user.selectOptions(within(form).getByLabelText('Default child option'), '512');
    await user.click(within(form).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Everywhere was saved.')).toBeVisible();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: { parent: 501, child: 512 } });
  });

  it('[CORE-009] gives a person field a default person', async () => {
    const user = userEvent.setup();
    const client = await renderField(6);
    const form = screen.getByRole('form', { name: 'Default value in Everywhere' });
    await user.type(within(form).getByLabelText('Default value'), 'Ana');
    await user.click(await within(form).findByRole('button', { name: 'Ana Ruiz' }));
    await user.click(within(form).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Everywhere was saved.')).toBeVisible();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: 41 });
  });

  it('[CORE-009] gives a number field a typed default', async () => {
    const user = userEvent.setup();
    const client = await renderField(7);
    const number = screen.getByRole('form', { name: 'Default value in Everywhere' });
    await user.type(within(number).getByLabelText('Default value'), '12.5');
    await user.click(within(number).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in Everywhere was saved.')).toBeVisible();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: '12.5' });
  });

  it('[CORE-009] keeps the keyboard on the page as forms close and contexts go', async () => {
    const user = userEvent.setup();
    await renderField(2);
    // New context keeps the keyboard and says the form is open; Cancel and Add give it back.
    const opener = screen.getByRole('button', { name: 'New context' });
    await user.click(opener);
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    let form = screen.getByRole('form', { name: 'Add a context' });
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(opener).toHaveFocus();
    await user.click(opener);
    form = screen.getByRole('form', { name: 'Add a context' });
    await user.type(within(form).getByLabelText('Context name'), 'Ops');
    await user.click(within(form).getByLabelText('Only these tracks'));
    await user.click(within(form).getByLabelText('OPS Operations'));
    await user.click(within(form).getByRole('button', { name: 'Add a context' }));
    expect(await screen.findByText('The context Ops was added.')).toBeVisible();
    expect(opener).toHaveFocus();

    // Saving a context's change gives the keyboard back to its Change.
    const change = screen.getByRole('button', { name: 'Change context Ops' });
    await user.click(change);
    form = screen.getByRole('form', { name: 'Change context Ops' });
    await user.click(within(form).getByRole('button', { name: 'Save the context' }));
    expect(await screen.findByText('The context Ops was saved.')).toBeVisible();
    expect(change).toHaveFocus();

    // A deleted context's row goes: the section's heading takes the keyboard.
    await user.click(screen.getByRole('button', { name: 'Delete context Ops' }));
    await user.click(
      within(screen.getByRole('group', { name: /^Delete Ops\?/ })).getByRole('button', {
        name: 'Delete context Ops',
      }),
    );
    expect(await screen.findByText('The context Ops was deleted.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Where Severity applies' })).toHaveFocus();

    // Remove the default goes once it is done: Save the default takes the keyboard.
    const defaults = screen.getByRole('form', { name: 'Default value in Everywhere' });
    await user.click(within(defaults).getByRole('button', { name: 'Remove the default' }));
    expect(await screen.findByText('Everywhere has no default now.')).toBeVisible();
    expect(within(defaults).getByRole('button', { name: 'Save the default' })).toHaveFocus();
  });

  it('[CORE-009] leaves out a track in the trash that a context still names', async () => {
    const user = userEvent.setup();
    // Track 9 is in the trash: the tracks list leaves it out, the context still names it.
    const client = await renderField(2, (c) => c.updateContext(2, 21, { trackIds: [1, 9] }));
    await user.click(screen.getByRole('button', { name: 'Change context Payments bugs' }));
    const form = screen.getByRole('form', { name: 'Change context Payments bugs' });
    expect(
      within(form).getByText(
        'A track it names is in the trash, so saving leaves it out of this context.',
      ),
    ).toBeVisible();
    await user.click(within(form).getByLabelText('OPS Operations'));
    await user.click(within(form).getByRole('button', { name: 'Save the context' }));
    expect(await screen.findByText('The context Payments bugs was saved.')).toBeVisible();
    expect(client.calls.at(-1)?.args[2]).toMatchObject({ trackIds: [1, 4] });
  });

  it('[CORE-009] a default naming an option no longer offered is left out, not refused', async () => {
    const user = userEvent.setup();
    // Components holds several: A and B are the default, then B stops being offered.
    const client = await renderField(3, async (c) => {
      for (const value of ['API', 'Billing', 'Cache']) await c.addOption(3, 30, value);
      const options = (await c.field(3)).contexts[0]?.options ?? [];
      const id = (value: string) => options.find((o) => o.value === value)?.id as number;
      await c.updateContext(3, 30, { defaultValue: [id('API'), id('Billing')] });
      await c.updateOption(3, 30, id('Billing'), { disabled: true });
    });
    const form = screen.getByRole('form', { name: 'Default value in OPS' });
    expect(
      within(form).getByText(
        'The default still names Billing, no longer offered here, so saving the default leaves that out.',
      ),
    ).toBeVisible();
    expect(within(form).getByLabelText('API')).toBeChecked();
    await user.click(within(form).getByLabelText('Cache'));
    await user.click(within(form).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('The default in OPS was saved.')).toBeVisible();
    const sent = client.calls.at(-1)?.args[2] as { defaultValue: number[] };
    expect(sent.defaultValue).toHaveLength(2);
    expect(screen.getByTestId('problem')).toHaveTextContent('');
    expect(within(form).queryByText(/no longer offered here/)).toBeNull();
  });

  it('[CORE-009] a single choice whose default is no longer offered saves as no default', async () => {
    const user = userEvent.setup();
    const client = await renderField(2, (c) => c.updateOption(2, 20, 201, { disabled: true }));
    const form = screen.getByRole('form', { name: 'Default value in Everywhere' });
    expect(within(form).getByText(/^The default still names Low, no longer offered/)).toBeVisible();
    expect(within(form).getByLabelText('Default value')).toHaveValue('');
    await user.click(within(form).getByRole('button', { name: 'Save the default' }));
    expect(await screen.findByText('Everywhere has no default now.')).toBeVisible();
    expect(client.calls.at(-1)?.args[2]).toEqual({ defaultValue: null });
  });

  it('[CORE-009] says a formula field takes no default', async () => {
    await renderField(8);
    expect(screen.getByText('A field of type Formula takes no default value.')).toBeVisible();
    expect(screen.queryByRole('form', { name: /^Default value/ })).toBeNull();
  });
});

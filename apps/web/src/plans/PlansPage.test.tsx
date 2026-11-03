import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakePlanClient } from './fixtures';
import { PlansPage } from './PlansPage';

function renderPlans() {
  const client = fakePlanClient();
  render(
    <I18nProvider locale="en">
      <PlansPage client={client} />
    </I18nProvider>,
  );
  return client;
}

afterEach(() => {
  window.location.hash = '';
});

describe('the plans (PLN-001)', () => {
  it('[PLN-001] lists the person’s plans and those shared with them', async () => {
    renderPlans();
    expect(await screen.findByRole('heading', { name: 'Multi-track' })).toBeVisible();
    const others = within(screen.getByRole('region', { name: 'Shared with you' }));
    expect(others.getByRole('link', { name: 'Data centre move' })).toHaveAttribute(
      'href',
      expect.stringContaining('/plans/13'),
    );
    expect(others.getByText('Bo Lindqvist · 3 sources')).toBeVisible();
  });

  it('[PLN-001] makes a plan from tracks and saved searches, never boards, and opens it', async () => {
    const user = userEvent.setup();
    const client = renderPlans();
    await user.click(await screen.findByRole('button', { name: 'New plan' }));
    const form = within(screen.getByRole('form', { name: 'New plan' }));
    await user.type(form.getByLabelText('Name'), 'Autumn');
    await user.click(await form.findByRole('checkbox', { name: 'OPS · Operations' }));
    await user.click(form.getByRole('checkbox', { name: 'Billing due' }));
    expect(form.getByText('2 sources chosen')).toBeVisible();
    expect(form.queryByText(/board/i)).toBeNull();
    // Narrowing the lists keeps what was ticked.
    await user.type(form.getByLabelText('Find a track or saved search'), 'shop');
    expect(form.queryByRole('checkbox', { name: 'OPS · Operations' })).toBeNull();
    await user.click(form.getByRole('checkbox', { name: 'SHOP · Shop' }));
    await user.click(form.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(window.location.hash).toBe('#/plans/14'));
    expect(client.saved.at(-1)).toEqual({
      name: 'Autumn',
      sources: [
        { kind: 'track', trackId: 2 },
        { kind: 'savedSearch', savedSearchId: 30 },
        { kind: 'track', trackId: 1 },
      ],
    });
  });
});

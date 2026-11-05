import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { EmptyState } from './EmptyState';
import { HelpTip } from './HelpTip';
import { PageHeader } from './PageHeader';

const inEnglish = (node: React.ReactNode) =>
  render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('the page header (ADR-114)', () => {
  it('[NFR-005] can take focus when the page asks, and not otherwise', () => {
    const heading = createRef<HTMLHeadingElement>();
    const { unmount } = inEnglish(<PageHeader title="Sign in" titleRef={heading} />);
    heading.current?.focus();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toHaveFocus();
    unmount();
    inEnglish(<PageHeader title="Home" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).not.toHaveAttribute('tabindex');
  });
});

describe('"What is this for?" (ADR-114)', () => {
  it('[NFR-005] opens and closes its explanation by click, keyboard and Escape', async () => {
    const user = userEvent.setup();
    inEnglish(<HelpTip name="Boards">Cards in columns.</HelpTip>);
    const button = screen.getByRole('button', { name: 'What is Boards for?' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Cards in columns.')).not.toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Cards in columns.')).toBeVisible();

    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByText('Cards in columns.')).toBeVisible();
  });

  it('closes when the person presses elsewhere', async () => {
    const user = userEvent.setup();
    inEnglish(
      <>
        <HelpTip name="Home">Your work.</HelpTip>
        <p>Outside</p>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'What is Home for?' }));
    await user.click(screen.getByText('Outside'));
    expect(screen.queryByText('Your work.')).not.toBeVisible();
  });
});

describe('the page header (ADR-114)', () => {
  it('[AGL-018] gives the page one level-one heading, its purpose and its actions', () => {
    inEnglish(
      <PageHeader
        title="Boards"
        eyebrow="Platform API"
        purpose="Cards in columns, one per step."
        about="More about boards."
        actions={<button type="button">Create board</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Boards' })).toBeVisible();
    expect(screen.getByText('Cards in columns, one per step.')).toBeVisible();
    expect(screen.getByText('Platform API')).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is Boards for?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create board' })).toBeVisible();
  });

  it('leaves out the help button when there is nothing more to say', () => {
    inEnglish(<PageHeader title="Home" purpose="Your work." />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('empty states (ADR-114)', () => {
  it('say what is missing, how it fills and the next step', () => {
    inEnglish(
      <EmptyState title="No boards yet" action={<a href="#/boards">Create a board</a>}>
        A board shows tickets as cards.
      </EmptyState>,
    );
    expect(screen.getByText('No boards yet')).toBeVisible();
    expect(screen.getByText('A board shows tickets as cards.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Create a board' })).toBeVisible();
  });

  it('[NFR-005] always draws the one picture, unless it is a short list inside a card', () => {
    const { container, unmount } = inEnglish(<EmptyState title="No boards yet" />);
    expect(container.querySelector('.empty-state-icon')).not.toBeNull();
    unmount();
    const compact = inEnglish(<EmptyState compact title="No alerts" />);
    expect(compact.container.querySelector('.empty-state-icon')).toBeNull();
    expect(screen.getByText('No alerts')).toBeVisible();
  });
});

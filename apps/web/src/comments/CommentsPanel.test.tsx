import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { SHOP_41 } from '../tickets/view/fixtures';
import { CommentsPanel } from './CommentsPanel';
import type { CommentList } from './client';
import { COMMENTS, fakeCommentClient, STATUS_LOCK } from './fixtures';

function renderPanel(
  start: Partial<CommentList> & { failAdd?: ApiError } = {},
  locale: Locale = 'en',
) {
  const client = fakeCommentClient(start);
  const view = render(
    <I18nProvider locale={locale}>
      <main>
        <CommentsPanel ticket={41} ticketKey="SHOP-41" client={client} />
      </main>
    </I18nProvider>,
  );
  return { ...view, client };
}
const panel = () => screen.getByRole('region', { name: 'Comments' });
const items = async () => within(panel()).findAllByRole('listitem');

describe('the comments section (M1-018)', () => {
  it('[CORE-020] lists comments with author, date, edits, restrictions and reactions', async () => {
    renderPanel();
    const [first, second, third] = (await items()) as HTMLElement[];
    expect(within(panel()).getByText('3 comments')).toBeVisible();
    expect(within(first as HTMLElement).getByText('Grace Hopper')).toBeVisible();
    // Rich text as text: the mention by name, links that open safely elsewhere.
    expect(first?.textContent).toContain('@Ada Lovelace can you look at the retry?');
    expect(within(second as HTMLElement).getByText(/^Edited /)).toBeVisible();
    expect(
      within(third as HTMLElement).getByText('Only the Administrators role can see this'),
    ).toBeVisible();
    const link = within(third as HTMLElement).getByRole('link', { name: 'security runbook' });
    expect(link).toHaveAttribute('href', 'https://example.com/runbook');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    // Reactions say their count and whether one is the reader's.
    expect(
      within(first as HTMLElement).getByRole('button', { name: '👍: 2 reactions, yours included' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(first as HTMLElement).getByRole('button', { name: '👀: 1 reaction' }),
    ).toHaveAttribute('aria-pressed', 'false');
    // Edit and delete only where the reader may.
    expect(within(first as HTMLElement).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(
      within(second as HTMLElement).getByRole('button', {
        name: /^Edit the comment by Ada Lovelace/,
      }),
    ).toBeVisible();
  });

  it('[CORE-020] adds a comment restricted to a role', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel({ comments: [] });
    expect(await within(panel()).findByText('No comments yet.')).toBeVisible();
    const editor = within(panel()).getByRole('textbox', { name: 'Add a comment' });
    await user.click(editor);
    await user.keyboard('Deploying the fix tonight');
    const who = await within(panel()).findByRole('combobox', { name: 'Who can see it' });
    await within(who).findByRole('option', { name: 'Administrators' });
    await user.selectOptions(who, 'role:7');
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }));
    expect(await within(panel()).findByText('Comment added.')).toBeInTheDocument();
    const [added] = await items();
    expect(added?.textContent).toContain('Deploying the fix tonight');
    expect(
      within(added as HTMLElement).getByText('Only the Administrators role can see this'),
    ).toBeVisible();
    expect(client.calls.find((c) => c.action === 'add')?.args[1]).toEqual({ roleId: 7 });
    // The form is empty again.
    expect(within(panel()).getByRole('textbox', { name: 'Add a comment' }).textContent).toBe('');
  });

  it('[CORE-020] asks for text first, and words a refusal', async () => {
    const user = userEvent.setup();
    renderPanel({
      comments: [],
      failAdd: new ApiError(400, {
        error: 'invalid_fields',
        fields: { visibility: 'not_a_member' },
      }),
    });
    await user.click(await within(panel()).findByRole('button', { name: 'Comment' }));
    expect(within(panel()).getByRole('alert')).toHaveTextContent('Write something first.');
    await user.click(within(panel()).getByRole('textbox', { name: 'Add a comment' }));
    await user.keyboard('Hello');
    await user.click(within(panel()).getByRole('button', { name: 'Comment' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'You can keep a comment to a group only if you are in it.',
    );
  });

  it('[CORE-020] edits and deletes a comment', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    await items();
    await user.click(
      within(panel()).getAllByRole('button', {
        name: /^Edit the comment by Ada Lovelace/,
      })[0] as HTMLElement,
    );
    const editor = within(panel()).getByRole('textbox', { name: /^Edit the comment by Ada/ });
    await user.click(editor);
    await user.keyboard('Merged. ');
    await user.click(within(panel()).getByRole('button', { name: 'Save' }));
    expect(await within(panel()).findByText('Comment saved.')).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'edit')?.args[0]).toBe(102);
    expect((await items())[1]?.textContent).toContain('Merged.');

    await user.click(
      within(panel()).getAllByRole('button', {
        name: /^Delete the comment by Ada Lovelace/,
      })[1] as HTMLElement,
    );
    expect(within(panel()).getByText('Delete this comment?')).toBeVisible();
    await user.click(within(panel()).getByRole('button', { name: 'Yes, delete' }));
    expect(await within(panel()).findByText('Comment deleted.')).toBeInTheDocument();
    expect(await items()).toHaveLength(2);
    expect(client.calls.at(-1)).toEqual({ action: 'remove', args: [103] });
  });

  it('[CORE-020] adds and removes reactions', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel({ comments: COMMENTS.slice(0, 1) });
    const [first] = (await items()) as HTMLElement[];
    const item = first as HTMLElement;
    await user.click(within(item).getByRole('button', { name: '👍: 2 reactions, yours included' }));
    expect(await within(item).findByRole('button', { name: '👍: 1 reaction' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const open = within(item).getByRole('button', { name: 'Add a reaction' });
    await user.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(item).getByRole('button', { name: 'React with 🎉' }));
    expect(
      await within(item).findByRole('button', { name: '🎉: 1 reaction, yours included' }),
    ).toBeVisible();
    expect(client.calls.filter((c) => c.action === 'react').map((c) => c.args)).toEqual([
      [101, '👍', false],
      [101, '🎉', true],
    ]);
    // Escape closes the picker and returns to its button.
    await user.click(open);
    await user.click(within(item).getByRole('button', { name: 'React with 👀' }));
    await user.click(open);
    within(item).getByRole('button', { name: 'React with 🚀' }).focus();
    await user.keyboard('{Escape}');
    expect(open).toHaveFocus();
    expect(within(item).queryByRole('button', { name: 'React with 🚀' })).toBeNull();
  });

  it('[WF-007] a status that reserves commenting says who may', async () => {
    renderPanel({ can: { add: false, react: true }, lock: STATUS_LOCK });
    await items();
    expect(within(panel()).queryByRole('textbox', { name: 'Add a comment' })).toBeNull();
    expect(
      within(panel()).getByText('In status Approved, only the Administrators role can comment.'),
    ).toBeVisible();
  });

  it('[CORE-020] copies a link to a comment, and a link brings it into view', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    window.location.hash = '#/tickets/SHOP-41?comment=102';
    renderPanel();
    const [, second] = (await items()) as HTMLElement[];
    expect(second).toHaveFocus();
    expect(second).toHaveClass('comment-target');
    await user.click(
      within(second as HTMLElement).getByRole('button', { name: /^Copy link to the comment/ }),
    );
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}${window.location.pathname}#/tickets/SHOP-41?comment=102`,
    );
    expect(await within(panel()).findByText('Link copied.')).toBeInTheDocument();
  });

  it('[CORE-020] sits on the ticket page and reads the comments from the backend', async () => {
    const ticket = SHOP_41;
    const calls = stubBackend({
      'GET /tickets/SHOP-41': () => jsonResponse(200, { ticket }),
      'GET /tickets/41/attachments': () =>
        jsonResponse(200, { attachments: [], maxFileSize: 1, canCreate: false, available: true }),
      'GET /tickets/41/comments?limit=100': () =>
        jsonResponse(200, {
          comments: COMMENTS,
          next: null,
          can: { add: false, react: true },
          lock: null,
        }),
      'PUT /tickets/41/comments/101/reactions/%F0%9F%91%80': () =>
        jsonResponse(200, { reactions: [{ emoji: '👀', count: 2, mine: true }] }),
    });
    window.location.hash = '#/tickets/SHOP-41';
    render(<App session={MEMBER} />);
    const comments = await screen.findByRole('region', { name: 'Comments' });
    expect(await within(comments).findAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(within(comments).getByRole('button', { name: '👀: 1 reaction' }));
    expect(
      await within(comments).findByRole('button', { name: '👀: 2 reactions, yours included' }),
    ).toBeVisible();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
      'PUT /tickets/41/comments/101/reactions/%F0%9F%91%80',
    );
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPanel();
    await items();
    expect(within(panel()).getByRole('button', { name: 'Comment' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPanel({}, 'en-XA');
    const region = await screen.findByRole('region');
    await within(region).findAllByRole('listitem');
    await within(region).findByRole('option', { name: 'Members' });
    // What people wrote, their names, dates and the names of roles and groups are data.
    const data = new Set<string>();
    for (const element of region.querySelectorAll(
      '.comment-body, .comment-author, .comment-date, option[value*=":"]',
    )) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        data.add((node.textContent ?? '').trim());
      }
    }
    const texts = visibleTexts(region).filter(
      (t) => !data.has(t) && !/^[\d,+]+$/.test(t) && !/\p{Extended_Pictographic}/u.test(t),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});
